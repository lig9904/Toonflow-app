import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import type { BuiltinExecutionContext } from "../builtinAgentRuntime";
import { BuiltinRuntimeError } from "../builtinAgentRuntime";
import { readProductionFlow, saveProductionPlanning, addProductionStoryboards, type NewStoryboard } from "../productionFlow";
import { createOrUpdateDerivedAsset } from "../productionAssets";
import { ProductionStateService } from "../productionState";
import type { AiType } from "../../utils/ai";
import type { StructuredModelRequest, StructuredScriptModel } from "./scriptExecutor";
import { createAssetExtractionHelper } from "./assetExtraction";
import { getCreativeState } from "../creativeWorkspace";
import pLimit from "p-limit";

export interface ProductionMediaRequest {
  ctx: BuiltinExecutionContext;
  projectId: number;
  scriptId: number;
  targetKind: "asset" | "storyboard" | "track";
  targetId: number;
  storyboardId?: number;
  modelKey: string;
  generationKey: string;
  params: Record<string, unknown>;
}

export interface ProductionMediaCapability {
  generateImage?(request: ProductionMediaRequest): Promise<unknown>;
  generateVideo?(request: ProductionMediaRequest): Promise<unknown>;
}

export interface ProductionExecutorDependencies {
  db: Knex;
  model: StructuredScriptModel;
  loadSkill(name: string): Promise<string>;
  media?: ProductionMediaCapability;
  videoModelMetadata?: (modelKey: string) => Promise<{ mode?: unknown; resolution?: unknown; audio?: unknown }>;
}

const phase = z.enum(["extractAssets", "planning", "directorPlan", "deriveAssets", "storyboard", "storyboardTable", "generateImages", "generateVideos", "review"]);
const planSchema = z.object({
  actions: z.array(phase).max(9),
  assetIds: z.array(z.number().int().positive()).max(500).default([]),
  storyboardIds: z.array(z.number().int().positive()).max(500).default([]),
  question: z.string().max(2000).nullable().default(null),
  summary: z.string().max(4000),
  videoSettings: z.object({ resolution: z.string().max(50).nullable().default(null), audio: z.boolean().nullable().default(null) }).strict().nullable().default(null),
}).strict();
const planningSchema = z.object({ scriptPlan: z.string().max(200_000), storyboardTable: z.string().max(200_000) }).strict();
const deriveSchema = z.object({ assets: z.array(z.object({ id: z.number().int().positive().nullable().default(null), expectedVersion: z.number().int().nonnegative().nullable().default(null), parentAssetId: z.number().int().positive(), name: z.string().trim().min(1).max(500), description: z.string().max(20_000) }).strict()).max(500) }).strict();
const storyboardSchema = z.object({
  items: z.array(z.object({
    id: z.number().int().positive().nullable().default(null),
    prompt: z.string().max(20_000), duration: z.number().positive().max(300), track: z.string().trim().min(1).max(100),
    videoDesc: z.string().max(20_000), shouldGenerateImage: z.number().int().min(0).max(1),
    associateAssetsIds: z.array(z.number().int().positive()).max(100), expectedVersion: z.number().int().nonnegative().nullable().default(null),
  }).strict()).max(500),
  summary: z.string().max(4000),
}).strict();
const reviewSchema = z.object({ findings: z.array(z.string().max(4000)).max(100), summary: z.string().max(4000) }).strict();

type CanonicalPhase = "extractAssets" | "planning" | "deriveAssets" | "storyboard" | "generateImages" | "generateVideos" | "review";
const ORDER: CanonicalPhase[] = ["extractAssets", "planning", "deriveAssets", "storyboard", "generateImages", "generateVideos", "review"];
const canonical = (value: z.infer<typeof phase>): CanonicalPhase => value === "directorPlan" ? "planning" : value === "storyboardTable" ? "storyboard" : value as CanonicalPhase;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type MediaTarget = { targetKind: "asset" | "storyboard" | "track"; targetId: number; storyboardIds: number[]; source: any };

export function createProductionAgentExecutor(deps: ProductionExecutorDependencies) {
  const extractAssets = createAssetExtractionHelper({ db: deps.db, model: deps.model });
  return async (ctx: BuiltinExecutionContext): Promise<unknown> => {
    const { run } = ctx;
    if (run.agentType !== "productionAgent" || run.projectId == null || run.scriptId == null) throw new BuiltinRuntimeError("INVALID_INPUT", "制作任务需要项目和剧集");
    const projectId = run.projectId;
    const scriptId = run.scriptId;
    const revision = run.inputRevision ?? 0;
    const requestText = run.continuation ? `${run.prompt}\n\n人工补充与续作要求：\n${run.continuation}` : run.prompt;
    const project = await ctx.step(`production.input:r${revision}`, { projectId, scriptId, requestText }, async () => {
      const row = await deps.db("o_project").where({ id: projectId }).first();
      const episode = await deps.db("o_script").where({ id: scriptId, projectId }).first();
      if (!row || !episode) throw new BuiltinRuntimeError("FORBIDDEN", "项目或剧集不属于当前任务");
      const scriptVersion = await getCreativeState(deps.db, "script", scriptId, projectId);
      return { id: projectId, scriptId, scriptVersion: scriptVersion.version, name: row.name ?? "", artStyle: row.artStyle ?? "", imageModel: row.imageModel ?? "", videoModel: row.videoModel ?? row.videoModelKey ?? "", imageQuality: row.imageQuality ?? "1K", videoRatio: row.videoRatio ?? "16:9", videoMode: row.mode ?? row.videoMode, videoResolution: row.videoResolution ?? row.resolution, audio: row.generateAudio ?? row.audio, script: episode.content ?? "" };
    });
    let flow = await ctx.step(`production.flow:r${revision}`, { projectId, scriptId }, () => readProductionFlow(deps.db, projectId, scriptId, async (path) => path));
    const skillCache = new Map<string, string>();
    const skill = async (name: string) => { if (!skillCache.has(name)) skillCache.set(name, await deps.loadSkill(name)); return skillCache.get(name)!; };
    const model = async <T>(key: string, role: StructuredModelRequest<T>["role"], skillName: string, schema: z.ZodType<T>, input: unknown, budget: number): Promise<T> => {
      if (budget < 128) throw new BuiltinRuntimeError("BUDGET_EXCEEDED", "输出额度不足以执行制作阶段");
      await ctx.assertActive();
      const system = `${await skill(skillName)}\n\n执行协议：只返回 schema 定义的结构化数据，不输出 XML，不直接操作界面，不声称已保存。所有项目、剧集、素材、分镜 ID 必须来自输入。`;
      const result = await ctx.step(`production.${key}:r${revision}`, { input, role, systemHash: hash(system), budget }, async () => {
        const generated = await deps.model.generate({ role, system, input, schema, maxOutputTokens: budget, signal: ctx.signal });
        return { value: schema.parse(generated.value), outputTokens: generated.outputTokens };
      }, { modelCall: true });
      return result.value;
    };
    const planBudget = Math.min(1800, Math.floor(run.limits.maxOutputTokens / 3));
    const plan = await model("plan", "productionAgent:decisionAgent", "production_agent_decision.md", planSchema, { request: requestText, project, flow, rules: "只选择用户明确要求的阶段；程序按固定顺序执行。generation 阶段必须列出真实 storyboardIds。review 只读。" }, planBudget);
    const actions: CanonicalPhase[] = plan.actions.map(canonical);
    if (new Set(actions).size !== actions.length) throw new BuiltinRuntimeError("INVALID_INPUT", "制作规划包含重复阶段");
    let knownTopAssets = new Set(flow.assets.map((asset: any) => Number(asset.id)));
    let knownAssets = new Set(flow.assets.flatMap((asset: any) => [Number(asset.id), ...asset.derive.map((child: any) => Number(child.id))]));
    let knownStoryboards = new Map(flow.storyboard.map((storyboard: any) => [Number(storyboard.id), storyboard]));
    if (plan.assetIds.some((id) => !knownAssets.has(id)) || plan.storyboardIds.some((id) => !knownStoryboards.has(id))) throw new BuiltinRuntimeError("INVALID_INPUT", "制作规划引用了项目外实体");
    if (plan.question) { await ctx.emit("message.completed", { text: plan.question }); await ctx.waitForHuman(plan.question, { projectId, scriptId }); }
    await ctx.emit("message.completed", { text: plan.summary });
    const selected = new Set(actions);
    const remainingBudget = run.limits.maxOutputTokens - planBudget;
    if (remainingBudget < actions.length * 128) throw new BuiltinRuntimeError("BUDGET_EXCEEDED", "输出额度不足以执行所选制作阶段");
    const budget = Math.floor(remainingBudget / Math.max(1, actions.length));
    const output: Record<string, unknown> = { projectId, scriptId, revision, actions };
    let targetAssetIds = [...new Set(plan.assetIds)];
    let targetStoryboardIds = [...new Set(plan.storyboardIds)];

    for (const action of ORDER) {
      if (!selected.has(action)) continue;
      if (action === "extractAssets") {
        const extraction = await extractAssets(ctx, { projectId, sourceScripts: [{ id: scriptId, expectedVersion: project.scriptVersion }], request: requestText, maxOutputTokens: budget, stepKey: "production.extractAssets" });
        output.assets = extraction;
        targetAssetIds = extraction.assetIds;
        flow = await readProductionFlow(deps.db, projectId, scriptId, async (path) => path);
        knownTopAssets = new Set(flow.assets.map((asset: any) => Number(asset.id)));
        knownAssets = new Set(flow.assets.flatMap((asset: any) => [Number(asset.id), ...asset.derive.map((child: any) => Number(child.id))]));
      } else if (action === "planning") {
        const planResult = await model("directorPlan", "productionAgent:directorPlanAgent", "production_execution_director_plan.md", planningSchema, { request: requestText, project, flow }, budget);
        const saved = await ctx.commit(`production.planning:r${revision}`, { projectId, scriptId, expected: flow.planningVersion, planResult }, (trx) => saveProductionPlanning(trx as unknown as Knex, projectId, scriptId, flow.planningVersion, planResult));
        output.planning = saved;
        flow = await readProductionFlow(deps.db, projectId, scriptId, async (path) => path);
        await ctx.emit("artifact.saved", { kind: "productionPlanning", ids: [projectId, scriptId], version: saved.planningVersion });
      } else if (action === "deriveAssets") {
        if (!targetAssetIds.length) await ctx.waitForHuman("请指定需要创建衍生版本的顶层素材", { projectId, scriptId });
        const derived = await model("deriveAssets", "productionAgent:deriveAssetsAgent", "production_execution_derive_assets.md", deriveSchema, { request: requestText, project, flow, parentAssetIds: targetAssetIds }, budget);
        const created = await ctx.commit(`production.assets:r${revision}`, { projectId, scriptId, derived }, async (trx) => {
          const ids: unknown[] = [];
          for (const item of derived.assets) {
            if (!knownTopAssets.has(item.parentAssetId) || !targetAssetIds.includes(item.parentAssetId)) throw new BuiltinRuntimeError("INVALID_INPUT", "衍生资产父 ID 必须是本次选定的项目顶层素材");
            const captured = item.id == null ? undefined : flow.assets.flatMap((asset: any) => asset.derive).find((asset: any) => Number(asset.id) === item.id);
            if (item.id != null && (!captured || (item.expectedVersion != null && item.expectedVersion !== Number(captured.version ?? 0)))) throw new BuiltinRuntimeError("CONFLICT", "衍生素材已不在读取范围或模型返回了错误版本");
            ids.push(await createOrUpdateDerivedAsset(trx as unknown as Knex, { projectId, scriptId, parentAssetId: item.parentAssetId, id: item.id ?? undefined,
              expectedVersion: captured ? Number(captured.version ?? 0) : undefined, actor: { id: `agent:${run.id}`, kind: "agent" }, name: item.name, description: item.description }));
          }
          return ids;
        });
        output.derivedAssets = created;
        targetAssetIds = (created as Array<{ id: number }>).map((item) => Number(item.id));
        flow = await readProductionFlow(deps.db, projectId, scriptId, async (path) => path);
        knownTopAssets = new Set(flow.assets.map((asset: any) => Number(asset.id)));
        knownAssets = new Set(flow.assets.flatMap((asset: any) => [Number(asset.id), ...asset.derive.map((child: any) => Number(child.id))]));
      } else if (action === "storyboard") {
        const storyboard = await model("storyboard", "productionAgent:storyboardTableAgent", "production_execution_storyboard_table.md", storyboardSchema, { request: requestText, project, flow, selectedStoryboardIds: plan.storyboardIds }, budget);
        const created = await ctx.commit(`production.storyboard.commit:r${revision}`, { projectId, scriptId, storyboard }, async (trx) => {
          const additions: NewStoryboard[] = [];
          const existingIds: number[] = [];
          for (const item of storyboard.items) {
            if (item.associateAssetsIds.some((id) => !knownAssets.has(id))) throw new BuiltinRuntimeError("INVALID_INPUT", "分镜引用了项目外素材");
            if (item.id == null) { additions.push({ prompt: item.prompt, duration: item.duration, track: item.track, videoDesc: item.videoDesc, shouldGenerateImage: item.shouldGenerateImage, associateAssetsIds: item.associateAssetsIds }); continue; }
            const old = knownStoryboards.get(item.id);
            if (!old) throw new BuiltinRuntimeError("INVALID_INPUT", "分镜 ID 不属于当前剧集");
            const capturedVersion = Number(old.collaboration?.version ?? 0);
            if (item.expectedVersion != null && item.expectedVersion !== capturedVersion) throw new BuiltinRuntimeError("CONFLICT", "模型返回的分镜版本不是读取时版本");
            existingIds.push(item.id);
          }
          if (existingIds.length) {
            const states = new ProductionStateService(trx as unknown as Knex);
            await states.guardStoryboardMutations({ projectId, storyboardIds: existingIds, expectedVersions: Object.fromEntries(existingIds.map((id) => [id, Number(knownStoryboards.get(id)!.collaboration?.version ?? 0)])), actor: { id: `agent:${run.id}`, kind: "agent" }, mutate: async (guardedTrx) => {
              for (const item of storyboard.items.filter((candidate) => candidate.id != null)) {
                const assetIds = [...new Set(item.associateAssetsIds)];
                let trackId = (await guardedTrx("o_storyboard").where({ projectId, scriptId, track: item.track }).first())?.trackId;
                if (!trackId) {
                  const [newTrack] = await guardedTrx("o_videoTrack").insert({ projectId, scriptId, duration: 0 }).returning("id");
                  trackId = typeof newTrack === "object" ? (newTrack as { id: number }).id : newTrack;
                }
                await guardedTrx("o_storyboard").where({ id: item.id, projectId, scriptId }).update({ prompt: item.prompt, videoDesc: item.videoDesc, duration: String(item.duration), track: item.track, trackId, shouldGenerateImage: item.shouldGenerateImage });
                await guardedTrx("o_assets2Storyboard").where({ storyboardId: item.id }).del();
                if (assetIds.length) await guardedTrx("o_assets2Storyboard").insert(assetIds.map((assetId) => ({ assetId, storyboardId: item.id })));
              }
              return undefined;
            }});
          }
          const newIds = additions.length ? await addProductionStoryboards(trx as unknown as Knex, projectId, scriptId, additions) : [];
          return [...existingIds, ...newIds];
        });
        output.storyboardIds = created;
        targetStoryboardIds = created;
        flow = await readProductionFlow(deps.db, projectId, scriptId, async (path) => path);
        knownStoryboards = new Map(flow.storyboard.map((storyboard: any) => [Number(storyboard.id), storyboard]));
        await ctx.emit("artifact.saved", { kind: "storyboards", ids: created });
      } else if (action === "generateImages" || action === "generateVideos") {
        if (!deps.media || (action === "generateImages" ? typeof deps.media.generateImage !== "function" : typeof deps.media.generateVideo !== "function")) throw new BuiltinRuntimeError("INVALID_INPUT", `${action} 媒体能力未配置，不能声称已完成`);
        const storyboardIds = targetStoryboardIds;
        const assetIds = action === "generateImages" ? targetAssetIds : [];
        const targets: MediaTarget[] = [];
        if (action === "generateVideos") {
          const grouped = new Map<number, number[]>();
          for (const id of storyboardIds) { const trackId = Number(knownStoryboards.get(id)?.trackId); if (!Number.isSafeInteger(trackId) || trackId <= 0) throw new BuiltinRuntimeError("INVALID_INPUT", "视频生成分镜缺少有效轨道 ID"); grouped.set(trackId, [...(grouped.get(trackId) ?? []), id]); }
          for (const [trackId, ids] of grouped) targets.push({ targetKind: "track", targetId: trackId, storyboardIds: ids, source: knownStoryboards.get(ids[0]) });
        } else {
          targets.push(...assetIds.map((id) => ({ targetKind: "asset" as const, targetId: id, storyboardIds: [], source: flow.assets.flatMap((asset: any) => [asset, ...asset.derive]).find((asset: any) => Number(asset.id) === id) })));
          targets.push(...storyboardIds.map((id) => ({ targetKind: "storyboard" as const, targetId: id, storyboardIds: [id], source: knownStoryboards.get(id) })));
        }
        const limit = action === "generateImages" ? run.limits.maxImageGenerations : run.limits.maxVideoGenerations;
        if (!targets.length) await ctx.waitForHuman("请明确本次要生成的素材、分镜或视频轨道", { action, projectId, scriptId });
        if (targets.length > limit) throw new BuiltinRuntimeError("BUDGET_EXCEEDED", `${action} 超过本次运行授权额度`);
        if (targets.some((item) => !item.source)) throw new BuiltinRuntimeError("INVALID_INPUT", "媒体生成引用了项目外实体");
        const results: unknown[] = [];
        const issues: Array<{ targetKind: string; targetId: number; message: string; result?: unknown }> = [];
        const performTarget = async (target: MediaTarget) => {
          await ctx.assertActive();
          const source = target.source as any;
          // A human answer or worker restart resumes the same generation. A new
          // generation of this target requires a new run with its own allowance.
          const generationKey = `builtin:${run.id}:${action}:${target.targetKind}:${target.targetId}`;
          const videoMetadata = action === "generateVideos" && deps.videoModelMetadata ? await deps.videoModelMetadata(project.videoModel) : {};
          const videoSources = action === "generateVideos" ? target.storyboardIds.map((id) => knownStoryboards.get(id)).filter(Boolean) as any[] : [];
          const storedVideoPrompt = videoSources.map((item) => item.videoDesc || item.prompt || "").filter(Boolean).join("\n");
          const storedImagePrompt = target.targetKind === "asset" && selected.has("deriveAssets") ? source.desc || source.prompt || source.name || "" : source.prompt || source.desc || source.name || "";
          const imagePromptUpdated = target.targetKind === "storyboard" ? selected.has("storyboard") : selected.has("deriveAssets") || selected.has("extractAssets");
          const imageRequest = imagePromptUpdated ? "" : requestText;
          const videoParams: Record<string, unknown> = action === "generateVideos" ? {
            mode: project.videoMode || videoMetadata.mode,
            resolution: plan.videoSettings?.resolution ?? project.videoResolution ?? videoMetadata.resolution,
            duration: videoSources.reduce((total, item) => total + Number(item.duration || 0), 0),
            audio: plan.videoSettings?.audio ?? project.audio ?? videoMetadata.audio ?? false,
            prompt: selected.has("storyboard") ? storedVideoPrompt : `${storedVideoPrompt}\n本次制作要求（优先落实其中的画面和声音要求）：${requestText}`,
            storyboardIds: target.storyboardIds,
            expectedVersions: Object.fromEntries(videoSources.map((item) => [Number(item.id), Number(item.collaboration?.version ?? 0)])),
          } : { prompt: [storedImagePrompt, project.artStyle ? `画风：${project.artStyle}` : "", imageRequest ? `本次画面要求（优先于旧画面描述）：${imageRequest}` : ""].filter(Boolean).join("\n"), size: project.imageQuality, aspectRatio: project.videoRatio,
            expectedVersion: target.targetKind === "storyboard" ? Number(source.collaboration?.version ?? 0) : Number(source.imageId ?? 0),
            referenceAssetIds: target.targetKind === "storyboard" ? source.associateAssetsIds ?? [] : source.assetsId != null ? [Number(source.assetsId)] : Number(source.imageId ?? 0) > 0 ? [target.targetId] : [],
            referenceStoryboardIds: target.targetKind === "storyboard" && source.src ? [target.targetId] : [] };
          if (action === "generateVideos" && (videoParams.mode === undefined || videoParams.resolution === undefined || Number(videoParams.duration) <= 0 || !videoParams.prompt)) throw new BuiltinRuntimeError("INVALID_INPUT", "视频生成缺少已验证的模式、分辨率、时长或提示词");
          const result = await ctx.step(`production.${action}:${target.targetKind}:${target.targetId}`, { projectId, scriptId, targetKind: target.targetKind, targetId: target.targetId, generationKey }, () => action === "generateImages" ? deps.media!.generateImage!({ ctx, projectId, scriptId, targetKind: target.targetKind, targetId: target.targetId, storyboardId: target.targetKind === "storyboard" ? target.targetId : undefined, modelKey: project.imageModel, generationKey, params: videoParams }) : deps.media!.generateVideo!({ ctx, projectId, scriptId, targetKind: "track", targetId: target.targetId, modelKey: project.videoModel, generationKey, params: videoParams }), { imageGeneration: action === "generateImages", videoGeneration: action === "generateVideos" });
          const status = mediaResultStatus(result);
          if (status === "pending") throw new BuiltinRuntimeError("INVALID_INPUT", `${action} callback must wait for final status before returning`);
          if (status === "needs_reconciliation") {
            if (!hasDurableReference(result)) throw new BuiltinRuntimeError("INVALID_INPUT", `${action} pending result lacks durable reference`);
            return { targetKind: target.targetKind, targetId: target.targetId, result, needsReview: true };
          }
          if (status !== "succeeded") throw new BuiltinRuntimeError("INVALID_INPUT", `${action} 未返回 completed status`);
          if (!hasDurableReference(result)) throw new BuiltinRuntimeError("INVALID_INPUT", `${action} completed result lacks durable reference`);
          return { targetKind: target.targetKind, targetId: target.targetId, result,
            needsReview: action === "generateImages" && (result as { selected?: boolean }).selected === false };
        };
        // Complete asset references before dependent storyboards; independent
        // targets share a bounded batch and retain every successful receipt.
        const batches = action === "generateImages" ? [targets.filter((target) => target.targetKind === "asset" && target.source.assetsId == null), targets.filter((target) => target.targetKind === "asset" && target.source.assetsId != null), targets.filter((target) => target.targetKind !== "asset")] : [targets];
        const failedAssetIds = new Set<number>();
        for (const batch of batches) {
          const concurrency = pLimit(2);
          const outcomes = await Promise.allSettled(batch.map((target) => concurrency(async () => {
            if (target.targetKind === "asset" && target.source.assetsId != null && failedAssetIds.has(Number(target.source.assetsId))) throw new BuiltinRuntimeError("CONFLICT", "父素材需要人工核对，该衍生图片暂未提交");
            if (target.targetKind === "storyboard" && (target.source.associateAssetsIds ?? []).some((id: number) => failedAssetIds.has(Number(id)))) throw new BuiltinRuntimeError("CONFLICT", "引用素材需要人工核对，该分镜暂未提交");
            return performTarget(target);
          })));
          for (let index = 0; index < outcomes.length; index++) {
            const outcome = outcomes[index], target = batch[index];
            if (outcome.status === "fulfilled") {
              results.push(outcome.value);
              if (outcome.value.needsReview) issues.push({ targetKind: target.targetKind, targetId: target.targetId, message: "生成结果已保留，需核对后选用", result: outcome.value.result });
            } else {
              const error = outcome.reason;
              if (error instanceof BuiltinRuntimeError && ["LEASE_LOST", "PAUSED", "CANCELLED", "WAITING_HUMAN"].includes(error.code)) throw error;
              issues.push({ targetKind: target.targetKind, targetId: target.targetId, message: error instanceof Error ? error.message : "媒体任务失败" });
            }
            if (target.targetKind === "asset" && (outcome.status === "rejected" || outcome.value.needsReview)) failedAssetIds.add(target.targetId);
          }
        }
        output[action] = results;
        flow = await readProductionFlow(deps.db, projectId, scriptId, async (path) => path);
        knownStoryboards = new Map(flow.storyboard.map((storyboard: any) => [Number(storyboard.id), storyboard]));
        if (issues.length) await ctx.waitForHuman("部分素材或镜头需要核对，其余成功结果已保存。请说明接下来处理的范围。", { action, completed: results, issues });
      } else if (action === "review") {
        const review = await model("review", "productionAgent:supervisionAgent", "production_agent_supervision.md", reviewSchema, { request: requestText, project, flow, output }, budget);
        output.review = review;
        await ctx.emit("message.completed", { text: [review.summary, ...review.findings].join("\n") });
      }
    }
    return output;
  };
}

function hasDurableReference(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["jobId", "taskId", "reference", "resultUrl"].some((key) => record[key] !== undefined && record[key] !== null && record[key] !== "");
}

function mediaResultStatus(value: unknown): "succeeded" | "pending" | "needs_reconciliation" | "invalid" {
  if (!value || typeof value !== "object") return "invalid";
  const status = (value as { status?: unknown }).status;
  if (status === "succeeded" || status === "pending" || status === "needs_reconciliation") return status;
  return "invalid";
}
