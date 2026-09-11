import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { BuiltinRuntimeError } from "../builtinAgentRuntime";
import type { ProductionMediaCapability, ProductionMediaRequest } from "./productionExecutor";
import type { ImageGenerationService, ImageGenerationReceipt } from "../imageJobs/runtime";
import { ImageGenerationError } from "../imageJobs/runtime";
import { VideoJobService, hashVideoJobRequest, type VideoJob, type VideoTaskProvider } from "../videoJobs";
import { loadOwnedVideoReferences, parseVideoMode, videoReferenceOptionsForProvider, type VideoReferenceInput } from "../videoJobs/request";
import { lockProjectTransaction } from "../../lib/dbTransaction";
import type { ResolvedImageModel } from "../../lib/imageModelSelection";
import { buildStoryboardImagePrompt, visualStyleHint } from "../../lib/storyboardVisualContract";
import { reconcileStoredStoryboardReferences } from "../storyboardVisuals";
import { snapshotImageReference, type ImageReferenceSnapshot } from "../imageJobs/referenceSnapshot";
import { matchVideoGenerationDuration, videoTailHoldInstruction } from "../../lib/videoGenerationTiming";
import { preflightVideoPrompt } from "../videoPromptReview";
import { buildVideoPromptReferenceCandidates, loadVideoReferenceInventory } from "../videoPromptComposition";
import { getCreativeState } from "../creativeWorkspace";
import type { prepareRuntimeVideoPromptForGeneration } from "../videoPromptCompositionRuntime";
import { captureVideoModeSelectionSnapshot, ensureVideoModeIntentSchema, readVideoModeIntent, resolveStoredVideoMode, revalidateVideoModeSelection } from "../videoModeResolution";
import type { StoredVideoModeSelection } from "../videoModeResolution";

export interface MediaModelCapabilities {
  type?: string;
  mode?: unknown[];
  audio?: boolean | "optional";
  durationResolutionMap?: Array<{ duration: number[]; resolution: string[] }>;
}
interface Dependencies {
  db: Knex;
  images: ImageGenerationService;
  videos: VideoJobService;
  imageModelFor(key: string, referenceCount: number): Promise<ResolvedImageModel>;
  modelFor(key: string, type: "image" | "video"): Promise<MediaModelCapabilities>;
  videoProviderFor(key: string): Promise<VideoTaskProvider>;
  toBase64(path: string): Promise<string>;
  visualStyleGuide?(styleName: string): string;
  mediaRootDir?: string;
  pollMs?: number;
  prepareVideoPrompt?: typeof prepareRuntimeVideoPromptForGeneration;
}

/** Match the existing Web's 480p/audio-off defaults when the model supports them. */
export function defaultVideoSettings(model: MediaModelCapabilities) {
  const resolutions = [...new Set((model.durationResolutionMap ?? []).flatMap((entry) => entry.resolution))];
  return { mode: "auto", resolution: resolutions.includes("480p") ? "480p" : resolutions[0], audio: model.audio === true };
}

export function validateVideoParameters(model: MediaModelCapabilities, params: Record<string, unknown>) {
  const mode = parseVideoMode(params.mode);
  if (mode !== "auto" && !(model.mode ?? []).some((allowed) => JSON.stringify(allowed) === JSON.stringify(mode))) throw new BuiltinRuntimeError("INVALID_INPUT", "视频模式不受当前模型支持");
  const duration = Number(params.duration);
  const resolution = String(params.resolution ?? "");
  if (!(model.durationResolutionMap ?? []).some((entry) => entry.duration.includes(duration) && entry.resolution.includes(resolution))) throw new BuiltinRuntimeError("INVALID_INPUT", "视频时长和分辨率组合不受当前模型支持，请调整轨道时长或模型");
  const audio = params.audio === true;
  if ((model.audio === false && audio) || (model.audio === true && !audio)) throw new BuiltinRuntimeError("INVALID_INPUT", "音频开关与当前模型能力不一致");
  return { mode, duration, resolution, audio };
}

export function agentVideoReferenceSelection(saved: StoredVideoModeSelection, inventory: Parameters<typeof buildVideoPromptReferenceCandidates>[0], trackId: number) {
  return saved.referencesInitialized ? saved.references : buildVideoPromptReferenceCandidates(inventory, trackId);
}

export function createProductionMediaCapabilities(deps: Dependencies): ProductionMediaCapability {
  const delay = Math.max(20, deps.pollMs ?? 1_000);
  return {
    async generateImage(request) {
      await request.ctx.assertActive();
      let receipt: ImageGenerationReceipt | undefined;
      try { receipt = await deps.images.get({ projectId: request.projectId, generationKey: request.generationKey }); }
      catch (error) { if (!(error instanceof ImageGenerationError) || error.code !== "NOT_FOUND") throw error; }
      if (receipt && (receipt.target.kind !== request.targetKind || Number(receipt.target.id) !== request.targetId)) throw new BuiltinRuntimeError("CONFLICT", "图片任务已绑定其他目标");
      if (!receipt) {
        let storyboardIds = Array.isArray(request.params.referenceStoryboardIds) ? request.params.referenceStoryboardIds.map(Number) : [];
        let assetIds = Array.isArray(request.params.referenceAssetIds) ? request.params.referenceAssetIds.map(Number) : [];
        let prompt = String(request.params.prompt ?? "");
        let expectedVersion = Number(request.params.expectedVersion ?? 0);
        let referenceAssets: ImageReferenceSnapshot[] | undefined;
        if (request.targetKind === "storyboard") {
          const versions = await reconcileStoredStoryboardReferences(deps.db, { projectId: request.projectId, scriptId: request.scriptId,
            storyboardIds: [request.targetId], expectedVersions: { [request.targetId]: expectedVersion } });
          expectedVersion = versions[request.targetId];
          const board = await deps.db("o_storyboard").where({ id: request.targetId, projectId: request.projectId, scriptId: request.scriptId }).first();
          const assets = await deps.db("o_assets2Storyboard as link").join("o_assets as asset", "asset.id", "link.assetId")
            .leftJoin("o_image as image", "image.id", "asset.imageId")
            .where("link.storyboardId", request.targetId).andWhere("asset.projectId", request.projectId).orderBy("link.id").select("asset.*", "image.filePath");
          const project = await deps.db("o_project").where({ id: request.projectId }).first();
          assetIds = assets.map((asset) => Number(asset.id));
          referenceAssets = assets.map((asset) => snapshotImageReference(asset, String(asset.filePath ?? "")));
          // Re-generation starts from canonical assets. Feeding an old rejected
          // storyboard back automatically would reinforce its wrong identity.
          storyboardIds = [];
          prompt = buildStoryboardImagePrompt({ ...board, assets,
            style: visualStyleHint(project?.artStyle ?? "", typeof request.params.visualStyleGuide === "string" ? request.params.visualStyleGuide : deps.visualStyleGuide?.(project?.artStyle ?? "") ?? ""),
            instruction: typeof request.params.imageInstruction === "string" ? request.params.imageInstruction : undefined,
          });
        }
        if (!referenceAssets && !storyboardIds.length && assetIds.length) {
          const assets = await deps.db("o_assets as asset").leftJoin("o_image as image", "image.id", "asset.imageId")
            .where("asset.projectId", request.projectId).whereIn("asset.id", assetIds).select("asset.*", "image.filePath");
          referenceAssets = assetIds.map((id) => {
            const asset = assets.find((row) => Number(row.id) === id);
            if (!asset?.filePath) throw new BuiltinRuntimeError("INVALID_INPUT", "素材参考图片缺失，请先生成或选择图片");
            return snapshotImageReference(asset, String(asset.filePath));
          });
        }
        const referenceInputs: VideoReferenceInput[] = [
          ...storyboardIds.map((id) => ({ id, sources: "storyboard" as const, fileType: "image" as const })),
          ...assetIds.map((id) => ({ id, sources: "assets" as const, fileType: "image" as const })),
        ];
        const references = await loadOwnedVideoReferences(deps.db, request.projectId, request.scriptId, referenceInputs, deps.toBase64);
        const referenceBoards = storyboardIds.length ? await deps.db("o_storyboard").where({ projectId: request.projectId, scriptId: request.scriptId }).whereIn("id", storyboardIds).select("id", "filePath") : [];
        const referenceAssetRows = assetIds.length ? await deps.db("o_assets as asset").leftJoin("o_image as image", "image.id", "asset.imageId").where("asset.projectId", request.projectId).whereIn("asset.id", assetIds).select("asset.id", "image.filePath") : [];
        const referencePaths = referenceInputs.map((input) => {
          const row = (input.sources === "storyboard" ? referenceBoards : referenceAssetRows).find((item) => Number(item.id) === input.id);
          return row?.filePath ? String(row.filePath) : undefined;
        });
        const model = await deps.imageModelFor(request.modelKey, references.length);
        const modes = model.mode ?? [];
        if (references.length === 0 && !modes.includes("text")) throw new BuiltinRuntimeError("INVALID_INPUT", "当前图片模型需要参考图，请先补齐素材图片");
        if (references.length > 1 && !modes.includes("multiReference")) throw new BuiltinRuntimeError("INVALID_INPUT", "当前图片模型不支持多参考图");
        if (references.length === 1 && !modes.includes("singleImage") && !modes.includes("multiReference")) throw new BuiltinRuntimeError("INVALID_INPUT", "当前图片模型不支持参考图");
        if (request.targetKind === "track") throw new BuiltinRuntimeError("INVALID_INPUT", "图片任务不能绑定视频轨道");
        await request.ctx.assertActive();
        receipt = await deps.images.prepare({ generationKey: request.generationKey, projectId: request.projectId, modelKey: request.modelKey,
          referenceAssets, referencePaths,
          config: { prompt, size: String(request.params.size ?? ""), aspectRatio: String(request.params.aspectRatio ?? ""), referenceList: references as Array<{ type: "image"; base64: string }> },
          target: { kind: request.targetKind, id: request.targetId, scriptId: request.scriptId, expectedVersion },
          builtinRun: { id: request.ctx.run.id, inputRevision: request.ctx.run.inputRevision ?? 0 },
        });
        await request.ctx.emit("media.reserved", { kind: "image", jobId: receipt.jobId, targetKind: request.targetKind, targetId: request.targetId });
      }
      while (receipt.status === "pending") {
        await request.ctx.assertActive();
        receipt = await deps.images.submitAndWait({ projectId: request.projectId, jobId: receipt.jobId, signal: request.ctx.signal, maxWaitMs: 5_000 });
      }
      await request.ctx.assertActive();
      if (receipt.status === "failed") throw new BuiltinRuntimeError("INVALID_INPUT", receipt.error ?? "图片生成失败");
      if (receipt.status === "succeeded" && receipt.artifactPath) await request.ctx.emit("artifact.saved", { kind: "image", jobId: receipt.jobId, targetKind: request.targetKind, targetId: request.targetId, path: receipt.artifactPath, selected: receipt.selected });
      return receipt;
    },
    async generateVideo(request) {
      await request.ctx.assertActive();
      let job = await deps.videos.findByIdempotency(request.projectId, request.generationKey);
      if (job && (job.scriptId !== request.scriptId || job.trackId !== request.targetId)) throw new BuiltinRuntimeError("CONFLICT", "视频任务已绑定其他轨道");
      if (!job) {
        const model = await deps.modelFor(request.modelKey, "video");
        const plannedDuration = Number(request.params.duration);
        let duration: number;
        try { duration = matchVideoGenerationDuration(model, plannedDuration, String(request.params.resolution ?? "")); }
        catch (error) { throw new BuiltinRuntimeError("INVALID_INPUT", error instanceof Error ? error.message : String(error)); }
        await ensureVideoModeIntentSchema(deps.db);
        const savedModeIntent = await readVideoModeIntent(deps.db, { projectId: request.projectId, scriptId: request.scriptId, trackId: request.targetId });
        const modeIntent = savedModeIntent.modeIntent;
        const baseSettings = validateVideoParameters(model, { ...request.params, mode: modeIntent, duration });
        const storyboardIds = Array.isArray(request.params.storyboardIds) ? [...new Set(request.params.storyboardIds.map(Number))] : [];
        const rows = await deps.db("o_storyboard").where({ projectId: request.projectId, scriptId: request.scriptId, trackId: request.targetId }).orderBy("index").orderBy("id");
        if (!storyboardIds.length || rows.length !== storyboardIds.length || rows.some((row) => !storyboardIds.includes(Number(row.id)))) throw new BuiltinRuntimeError("INVALID_INPUT", "视频生成必须包含当前轨道的完整分镜，请重新读取轨道");

        const inventory = await loadVideoReferenceInventory(deps.db,{projectId:request.projectId,scriptId:request.scriptId,trackIds:[request.targetId]});
        let modeResolution;
        try { modeResolution = await resolveStoredVideoMode(deps.db, { projectId: request.projectId, scriptId: request.scriptId, trackId: request.targetId, model: request.modelKey, capabilities: model, references: agentVideoReferenceSelection(savedModeIntent, inventory, request.targetId), expectedIntentRevision: savedModeIntent.revision }); }
        catch (error) { throw new BuiltinRuntimeError("INVALID_INPUT", error instanceof Error ? error.message : String(error)); }
        const settings = { ...baseSettings, mode: modeResolution.resolvedMode };
        const referenceInputs = modeResolution.resolvedReferences;
        await request.ctx.emit("video.modeResolved", modeResolution);
        const provider = await deps.videoProviderFor(request.modelKey);
        const modeSnapshot=await captureVideoModeSelectionSnapshot(deps.db,{projectId:request.projectId,scriptId:request.scriptId,trackId:request.targetId,resolution:modeResolution},deps.toBase64);
        const referenceList = await loadOwnedVideoReferences(deps.db, request.projectId, request.scriptId, referenceInputs, deps.toBase64,
          videoReferenceOptionsForProvider(provider, deps.mediaRootDir ?? "", request.modelKey));
        await revalidateVideoModeSelection(deps.db,{projectId:request.projectId,scriptId:request.scriptId,trackId:request.targetId,snapshot:modeSnapshot},deps.toBase64);
        const project = await deps.db("o_project").where({ id: request.projectId }).first();
        const expectedTrackVersion = Number.isSafeInteger(request.params.expectedTrackVersion) ? Number(request.params.expectedTrackVersion) : (await getCreativeState(deps.db,"track",request.targetId,request.projectId)).version;
        const input = {projectId:request.projectId,scriptId:request.scriptId,trackId:request.targetId,model:request.modelKey,mode:typeof settings.mode === "string"?settings.mode:JSON.stringify(settings.mode),info:referenceInputs,modeIntentSnapshot:{modeIntent:modeResolution.modeIntent,revision:savedModeIntent.revision},generation:{duration:settings.duration,resolution:settings.resolution,audio:settings.audio},expectedVersion:expectedTrackVersion,idempotencyKey:`${request.generationKey}:prompt`};
        let prepared;
        if (deps.prepareVideoPrompt) {
          prepared = await deps.prepareVideoPrompt(input, {
            generateDraft: (job,invoke) => request.ctx.step(`video.prompt.draft:${request.targetId}`,{jobId:job.id},invoke,{modelCall:true}),
            reviewDraft: (job,draft,invoke) => request.ctx.step(`video.prompt.review:${request.targetId}`,{jobId:job.id,draftHash:createHash("sha256").update(draft).digest("hex")},invoke,{modelCall:true}),
          }, {db:deps.db,capabilities:model,visualManual:typeof request.params.visualStyleGuide === "string"?request.params.visualStyleGuide:undefined});
        } else {
          const track=await deps.db("o_videoTrack").where({id:request.targetId,projectId:request.projectId,scriptId:request.scriptId}).first();
          const version=(await getCreativeState(deps.db,"track",request.targetId,request.projectId)).version;
          if(version!==expectedTrackVersion)throw new BuiltinRuntimeError("CONFLICT","轨道提示词已变化，请重新读取");
          if(!track?.prompt?.trim())throw new BuiltinRuntimeError("INVALID_INPUT","当前视频提示词为空，未配置统一提示词准备服务");
          prepared={prompt:track.prompt,trackVersion:version,stale:false};
        }
        if(prepared.stale)throw new BuiltinRuntimeError("CONFLICT","源分镜已更新，已保留人工提示词；请在画布核对并保存提示词后重新发起生成");
        const config = { ...settings, prompt: [prepared.prompt,String(request.params.instructions??""),videoTailHoldInstruction(plannedDuration, duration)].filter(Boolean).join("\n"), referenceList, aspectRatio: project?.videoRatio, toonflowModeSelection: modeSnapshot };
        if (!config.prompt || !config.aspectRatio) throw new BuiltinRuntimeError("INVALID_INPUT", "视频提示词或画幅缺失");
        const promptReview = await preflightVideoPrompt(deps.db, { projectId: request.projectId, scriptId: request.scriptId,
          trackId: request.targetId, prompt: config.prompt, model: request.modelKey, mode: settings.mode,
          generation: { duration: settings.duration, resolution: settings.resolution, audio: settings.audio }, info: referenceInputs });
        await request.ctx.emit("video.promptReview", { trackId: request.targetId, review: promptReview });
        const requestHash = hashVideoJobRequest({ modelKey: request.modelKey, providerFingerprint: provider.fingerprint, projectId: request.projectId, scriptId: request.scriptId, trackId: request.targetId, config });
        const pathKey = createHash("sha256").update(request.generationKey).digest("hex");
        const reserved = await request.ctx.commit(`video.reserve:${request.targetId}`, { generationKey: request.generationKey, requestHash }, async (trx) => {
          await lockProjectTransaction(trx, request.projectId);
          await assertTrackUnchanged(trx, request, rows);
          const currentTrack=await trx("o_videoTrack").where({id:request.targetId,projectId:request.projectId,scriptId:request.scriptId}).first();
          if((await getCreativeState(trx,"track",request.targetId,request.projectId)).version!==prepared.trackVersion||currentTrack?.prompt!==prepared.prompt)throw new BuiltinRuntimeError("CONFLICT","人工视频提示词已修改，本次旧请求未提交");
          const currentModeIntent=await readVideoModeIntent(trx,{projectId:request.projectId,scriptId:request.scriptId,trackId:request.targetId});
          const selection=(value:typeof currentModeIntent)=>({modeIntent:value.modeIntent,references:value.references,referencesInitialized:value.referencesInitialized,revision:value.revision});
          if(JSON.stringify(selection(currentModeIntent))!==JSON.stringify(selection(savedModeIntent)))throw new BuiltinRuntimeError("CONFLICT","视频生成方式或参考用途已变化，本次旧请求未提交");
          if(JSON.stringify(await loadVideoReferenceInventory(trx,{projectId:request.projectId,scriptId:request.scriptId,trackIds:[request.targetId]}))!==JSON.stringify(inventory))throw new BuiltinRuntimeError("CONFLICT","视频参考或绑定音色已变化，本次旧请求未提交");
          return deps.videos.reserveNewVideos([{ idempotencyKey: request.generationKey, request: { modelKey: request.modelKey, providerFingerprint: provider.fingerprint,
            projectId: request.projectId, scriptId: request.scriptId, trackId: request.targetId, config, outputPath: `/${request.projectId}/video/${pathKey}.mp4` }, requestHash }], trx).then((results) => results[0]);
        });
        job = reserved.job;
        await request.ctx.emit("media.reserved", { kind: "video", jobId: job.id, videoId: job.videoId, trackId: job.trackId });
        await request.ctx.assertActive();
        if (reserved.created) job = await deps.videos.submitReserved(job.id);
      }
      while (!["SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED"].includes(job.status)) {
        await request.ctx.assertActive();
        await wait(delay, request.ctx.signal);
        await request.ctx.assertActive();
        await deps.videos.resumeDueJobs();
        job = await deps.videos.get(job.id);
      }
      await request.ctx.assertActive();
      if (job.status === "FAILED") throw new BuiltinRuntimeError("INVALID_INPUT", job.lastError ?? "视频生成失败");
      const result = videoReceipt(job);
      await request.ctx.emit("artifact.saved", { kind: "video", ...result });
      return result;
    },
  };
}

async function assertTrackUnchanged(trx: Knex.Transaction, request: ProductionMediaRequest, previous: any[]) {
  const rows = await trx("o_storyboard").where({ projectId: request.projectId, scriptId: request.scriptId, trackId: request.targetId }).orderBy("index").orderBy("id");
  const fields = (row: any) => [Number(row.id), row.prompt, row.videoDesc, row.filePath, row.duration, Number(row.trackId)];
  if (JSON.stringify(rows.map(fields)) !== JSON.stringify(previous.map(fields))) throw new BuiltinRuntimeError("CONFLICT", "视频引用的分镜已发生变化");
  const states = await trx("ext_entity_state").where({ projectId: request.projectId, entityType: "storyboard" }).whereIn("entityId", rows.map((row) => row.id));
  const versions = (request.params.expectedVersions ?? {}) as Record<string, number>;
  for (const row of rows) {
    const state = states.find((item) => Number(item.entityId) === Number(row.id));
    if (state?.locked || Number(state?.version ?? 0) !== Number(versions[String(row.id)])) throw new BuiltinRuntimeError("CONFLICT", "分镜已被锁定或修改，不能提交旧的视频生成请求");
  }
}
function videoReceipt(job: VideoJob) {
  return { status: job.status === "SUCCEEDED" ? "succeeded" : "needs_reconciliation", jobId: job.id, taskId: job.upstreamTaskId,
    videoId: job.videoId, trackId: job.trackId, artifactPath: job.status === "SUCCEEDED" ? job.outputPath : undefined, selected: false, error: job.lastError };
}
function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => { const timer = setTimeout(done, ms); function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); });
}
