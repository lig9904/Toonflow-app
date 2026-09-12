import { assertVideoPromptDialogue, type VideoPromptReviewReport } from "@/lib/videoPromptContract";
import { validatePromptReferenceSelection, type VideoPromptComposition, type VideoGenerationSettings } from "./videoPromptComposition";
import { currentPromptReferences, deterministicPromptFindings, promptReviewBinding } from "./videoPromptReview";
import { resolveVideoReferenceMediaType } from "../lib/videoPromptReferences";
import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { lockProjectTransaction } from "@/lib/dbTransaction";
import { advanceCreativeState, getCreativeState } from "@/services/creativeWorkspace";
import { buildStoryboardVideoPrompt, visualText } from "@/lib/storyboardVisualContract";
import { isVolcengineTrustedModel, readPromptTrustedBindings } from "./volcengineReferenceRuntime";
import { assertTrackWritable } from "./storyboardTrackIndependence";
import { acknowledgeVideoPromptReferences, ensureVideoModeIntentSchema, type VideoModeIntent, type VideoReferencePurpose } from "./videoModeResolution";

const JOBS = "ext_video_prompt_jobs";
const ready = new WeakMap<object, Promise<void>>();
const executing = new WeakMap<object, Map<string, Promise<VideoPromptJob>>>();
export type VideoPromptJobState = "queued" | "running" | "succeeded" | "failed";

export interface VideoPromptJobInput {
  projectId: number;
  scriptId: number;
  trackId: number;
  model: string;
  mode: string;
  info: Array<{ id: number; sources: string; fileType?: "image" | "video" | "audio"; purpose?: VideoReferencePurpose }>;
  modeIntentSnapshot?: { modeIntent: VideoModeIntent; revision: number };
  idempotencyKey: string;
  expectedVersion: number;
  generation?: VideoGenerationSettings;
}

export interface VideoPromptSource {
  id: number;
  version?: number;
  prompt?: string | null;
  videoDesc?: string | null;
  duration?: number | string | null;
}

export interface VideoPromptJob {
  id: string;
  projectId: number;
  scriptId: number;
  trackId: number;
  model: string;
  mode: string;
  state: VideoPromptJobState;
  trackVersion: number;
  sourceSnapshot: VideoPromptSource[];
  referenceSnapshot: unknown;
  promptInput: string;
  compositionSnapshot?: VideoPromptComposition | null;
  referenceLabels?: string[];
  promptReview?: VideoPromptReviewReport | null;
  resultPrompt?: string | null;
  reason?: string | null;
}

export async function findVideoPromptJobByIdempotency(db: Knex, input: Pick<VideoPromptJobInput, "projectId" | "scriptId" | "trackId" | "idempotencyKey">): Promise<VideoPromptJob | null> {
  await ensureVideoPromptJobSchema(db);
  const row = await db(JOBS).where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, idempotencyKey: input.idempotencyKey }).first();
  return row ? toJob(row) : null;
}

export class VideoPromptJobError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "VERSION_CONFLICT", message: string) {
    super(message);
    this.name = "VideoPromptJobError";
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function json<T>(value: unknown): T { return typeof value === "string" ? JSON.parse(value) as T : value as T; }
function positive(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new VideoPromptJobError("INVALID_INPUT", `${name} 无效`);
  return n;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !/^[\w:.-]{8,150}$/.test(value)) throw new VideoPromptJobError("INVALID_INPUT", "缺少有效提示词任务编号");
  return value;
}
function version(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new VideoPromptJobError("INVALID_INPUT", "缺少有效轨道版本");
  return n;
}

export async function ensureVideoPromptJobSchema(db: Knex): Promise<void> {
  const existing = ready.get(db);
  if (existing) return existing;
  const work = db.transaction(async (trx) => {
    if (!(await trx.schema.hasTable(JOBS))) {
      await trx.schema.createTable(JOBS, (table) => {
        table.text("id").primary();
        table.bigInteger("projectId").notNullable();
        table.bigInteger("scriptId").notNullable();
        table.bigInteger("trackId").notNullable();
        table.text("model").notNullable();
        table.text("mode").notNullable();
        table.text("idempotencyKey").notNullable();
        table.text("requestHash").notNullable();
        table.text("requestIdentityHash").notNullable();
        table.text("state").notNullable();
        table.integer("trackVersion").notNullable();
        table.jsonb("sourceSnapshot").notNullable();
        table.jsonb("referenceSnapshot").notNullable();
        table.text("promptInput").notNullable();
        table.text("resultPrompt").nullable();
        table.text("reason").nullable();
        table.bigInteger("createdAt").notNullable();
        table.bigInteger("updatedAt").notNullable();
        table.unique(["projectId", "scriptId", "trackId", "idempotencyKey"]);
        table.index(["projectId", "scriptId", "trackId", "state"]);
      });
    }
    if (!(await trx.schema.hasColumn(JOBS, "requestIdentityHash"))) await trx.schema.alterTable(JOBS, (table) => table.text("requestIdentityHash").notNullable().defaultTo(""));
    if (!(await trx.schema.hasColumn(JOBS, "referenceSnapshot"))) await trx.schema.alterTable(JOBS, (table) => table.jsonb("referenceSnapshot").notNullable().defaultTo("{}"));
    for (const column of ["compositionSnapshot", "referenceLabels", "reviewReport"]) {
      if (!(await trx.schema.hasColumn(JOBS, column))) await trx.schema.alterTable(JOBS, (table) => table.jsonb(column).nullable());
    }
    if (!(await trx.schema.hasColumn(JOBS, "reviewBinding"))) await trx.schema.alterTable(JOBS, (table) => table.text("reviewBinding").nullable());
    // A process restart cannot resume an in-memory model call. Resolve jobs
    // left active by the previous process so the UI never polls forever.
    const reason = "提示词任务因服务重启未完成，请重新生成";
    await trx(JOBS).whereIn("state", ["queued", "running"]).update({ state: "failed", reason, updatedAt: Date.now() });
    // Version 4.6 did not have durable prompt receipts. Its orphaned track
    // flags must converge too; video generation state lives on o_video.
    await trx("o_videoTrack").where("state", "生成中").update({ state: "生成失败", reason });
  });
  ready.set(db, work);
  try { await work; } catch (error) { ready.delete(db); throw error; }
}

function toJob(row: any): VideoPromptJob {
  return {
    id: String(row.id), projectId: Number(row.projectId), scriptId: Number(row.scriptId), trackId: Number(row.trackId), model: String(row.model), mode: String(row.mode),
    compositionSnapshot: json(row.compositionSnapshot ?? null), referenceLabels: json(row.referenceLabels ?? []), promptReview: json(row.reviewReport ?? null),
    state: row.state, trackVersion: Number(row.trackVersion), sourceSnapshot: json<VideoPromptSource[]>(row.sourceSnapshot), referenceSnapshot: json(row.referenceSnapshot ?? null), promptInput: String(row.promptInput), resultPrompt: row.resultPrompt ?? null, reason: row.reason ?? null,
  };
}

export async function prepareVideoPromptJob(db: Knex, input: VideoPromptJobInput, options: { compose?: (context: { db: Knex; scriptDuration: number; referenceCount: number }) => Promise<VideoPromptComposition> } = {}): Promise<{ job: VideoPromptJob; reused: boolean }> {
  await ensureVideoPromptJobSchema(db);
  await ensureVideoModeIntentSchema(db);
  const projectId = positive(input.projectId, "projectId");
  const scriptId = positive(input.scriptId, "scriptId");
  const trackId = positive(input.trackId, "trackId");
  const idempotencyKey = key(input.idempotencyKey);
  const expectedVersion = version(input.expectedVersion);
  if (typeof input.model !== "string" || !input.model.trim() || typeof input.mode !== "string") throw new VideoPromptJobError("INVALID_INPUT", "模型或模式无效");
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    if (!(await trx("o_script").where({ id: scriptId, projectId }).first())) throw new VideoPromptJobError("CONFLICT", "剧集不属于当前项目");
    const track = await trx("o_videoTrack").where({ id: trackId, projectId, scriptId }).forUpdate().first();
    if (!track) throw new VideoPromptJobError("CONFLICT", "视频轨道不属于当前项目或剧集");
    await assertTrackWritable(trx, projectId, trackId).catch(() => { throw new VideoPromptJobError("CONFLICT", "历史共享轨道已归档，不能继续生成提示词"); });
    if (Number((await trx("o_storyboard").where({ projectId, scriptId, trackId }).count("id as count").first())?.count ?? 0) > 1) throw new VideoPromptJobError("CONFLICT", "该历史片段仍包含多条分镜，请先完成一镜一片段迁移");
    const requestIdentityHash = hash({ projectId, scriptId, trackId, model: input.model, mode: input.mode, info: input.info, modeIntentSnapshot: input.modeIntentSnapshot, expectedVersion, ...(input.generation === undefined ? {} : { generation: input.generation }) });
    const existingByRequest = await trx(JOBS).where({ projectId, scriptId, trackId, idempotencyKey }).first();
    if (existingByRequest) {
      if (existingByRequest.requestIdentityHash && existingByRequest.requestIdentityHash !== requestIdentityHash) throw new VideoPromptJobError("CONFLICT", "提示词任务编号已用于不同请求");
      return { job: toJob(existingByRequest), reused: true };
    }
    const trackState = await getCreativeState(trx, "track", trackId, projectId);
    if (trackState.version !== expectedVersion) throw new VideoPromptJobError("VERSION_CONFLICT", "轨道已被其他成员或任务修改，请读取最新版本");
    const sourceRows = await trx("o_storyboard").where({ projectId, scriptId, trackId }).orderBy("index").orderBy("id").select("id", "prompt", "videoDesc", "duration");
    if (!sourceRows.length) throw new VideoPromptJobError("INVALID_INPUT", "当前轨道没有可用于生成提示词的源分镜");
    const sourceStates = await trx("ext_entity_state").where({ projectId, entityType: "storyboard" }).whereIn("entityId", sourceRows.map((row) => Number(row.id))).select("entityId", "version");
    const sourceSnapshot = sourceRows.map((row) => ({ ...row, version: Number(sourceStates.find((state) => Number(state.entityId) === Number(row.id))?.version ?? 0) }));
    const storyboardIds = new Set(sourceSnapshot.map((row) => Number(row.id)));
    const locked = await trx("ext_entity_state").where({ projectId, entityType: "storyboard", locked: 1 }).whereIn("entityId", [...storyboardIds]).first();
    if (locked) throw new VideoPromptJobError("CONFLICT", "当前轨道包含已锁定分镜，不能生成提示词");
    for (const item of input.info ?? []) {
      const id = positive(item.id, "info.id");
      if (item.sources === "storyboard" && !(await trx("o_storyboard").where({ id, projectId, scriptId }).first())) throw new VideoPromptJobError("CONFLICT", "参考分镜不属于当前项目或剧集");
      if (item.sources === "assets" && !(await trx("o_assets").where({ id, projectId }).first())) throw new VideoPromptJobError("CONFLICT", "参考素材不属于当前项目");
      if (!["storyboard", "assets"].includes(item.sources)) throw new VideoPromptJobError("INVALID_INPUT", "参考来源无效");
    }
    const selectedStoryboardIds = new Set((input.info ?? []).filter((item) => item.sources === "storyboard").map((item) => Number(item.id)));
    const selectedAssetIds = new Set((input.info ?? []).filter((item) => item.sources === "assets").map((item) => Number(item.id)));
    const linkedAssets = await trx("o_assets2Storyboard as link").join("o_assets as asset", "asset.id", "link.assetId")
      .where("asset.projectId", projectId).whereIn("link.storyboardId", [...storyboardIds]).orderBy("link.id")
      .select("asset.id", "asset.name", "asset.describe", "asset.type", "asset.imageId");
    const selectedAssetRows = selectedAssetIds.size
      ? await trx("o_assets as asset").leftJoin("o_image as image", "image.id", "asset.imageId").where("asset.projectId", projectId).whereIn("asset.id", [...selectedAssetIds]).select("asset.id", "asset.name", "asset.describe", "asset.type", "asset.imageId", "image.filePath", "image.type as mediaType")
      : [];
    const selectedAssets = (input.info ?? []).filter((item) => item.sources === "assets").map((item) => selectedAssetRows.find((row) => Number(row.id) === Number(item.id))).filter(Boolean);
    const selectedStoryboardRows = selectedStoryboardIds.size
      ? await trx("o_storyboard").where({ projectId, scriptId }).whereIn("id", [...selectedStoryboardIds]).select("id", "prompt", "videoDesc", "duration", "trackId", "filePath")
      : [];
    const selectedStoryboards = (input.info ?? []).filter((item) => item.sources === "storyboard").map((item) => selectedStoryboardRows.find((row) => Number(row.id) === Number(item.id))).filter(Boolean);
    const referencedAssetIds = [...new Set([...selectedAssetIds, ...linkedAssets.map((row) => Number(row.id))])];
    const [storyboardStates, assetStates] = await Promise.all([
      selectedStoryboardIds.size ? trx("ext_entity_state").where({ projectId, entityType: "storyboard" }).whereIn("entityId", [...selectedStoryboardIds]).select("entityId", "version") : [],
      referencedAssetIds.length ? trx("ext_creative_state").where({ projectId, entityType: "asset" }).whereIn("entityId", referencedAssetIds).select("entityId", "version") : [],
    ]);
    const referenceVersion = (entityType: "storyboard" | "asset", entityId: unknown) => Number((entityType === "storyboard" ? storyboardStates : assetStates).find((state) => Number(state.entityId) === Number(entityId))?.version ?? 0);
    const versionedStoryboards = selectedStoryboards.map((row) => ({ ...row, version: referenceVersion("storyboard", row.id) }));
    const versionedAssets = selectedAssets.map((row) => ({ ...row, version: referenceVersion("asset", row.id) }));
    const versionedLinkedAssets = linkedAssets.map((row) => ({ ...row, version: referenceVersion("asset", row.id) }));
    const selectedStoryboardById = new Map(versionedStoryboards.map((row) => [Number(row.id), row]));
    const selectedAssetById = new Map(versionedAssets.map((row) => [Number(row.id), row]));
    const referenceCounts = { image: 0, video: 0, audio: 0 };
    const referenceLabels: string[] = [];
    const trustedAssets = isVolcengineTrustedModel(input.model) ? await readPromptTrustedBindings(trx, projectId, scriptId, input.info ?? []) : undefined;
    const selectedVisual = (input.info ?? []).map((item, index) => {
      const row = item.sources === "storyboard" ? selectedStoryboardById.get(Number(item.id)) : selectedAssetById.get(Number(item.id));
      const trusted = trustedAssets?.find((entry) => entry.inputIndex === index);
      if (trusted && (!trusted.sourceCurrent || trusted.remoteStatus !== "Active")) throw new VideoPromptJobError("INVALID_INPUT", "火山素材绑定已过期或来源已变化，请重新同步并绑定后生成提示词");
      if (!row?.filePath) throw new VideoPromptJobError("INVALID_INPUT", "所选参考尚无媒体文件，不能编造上传标签");
      const mediaType = item.sources === "storyboard" ? "image" : resolveVideoReferenceMediaType(row.mediaType, row.type, row.filePath);
      if (item.fileType && item.fileType !== mediaType) throw new VideoPromptJobError("INVALID_INPUT", "参考媒体类型与实际素材不一致");
      const label = { image: "图片", video: "视频", audio: "音频" }[mediaType];
      const number = ++referenceCounts[mediaType];
      referenceLabels.push(`@${label}${number}`);
      const framePosition = item.purpose === "first_frame" ? "，帧位置：首帧" : item.purpose === "last_frame" ? "，帧位置：尾帧" : !item.purpose && ["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional"].includes(input.mode) ? (index === 0 ? "，帧位置：首帧" : "，帧位置：尾帧") : "";
      return `选择顺序${index + 1}，@${label}${number}${framePosition}${item.purpose ? `，用途：${item.purpose}` : ""}，来源 ${item.sources} ${Number(item.id)}：${row.name ?? "分镜参考"}；${visualText(row.describe ?? row.prompt ?? "")}${trusted ? "；实际输入为已绑定火山素材，本地图片仅用于关联；最终提示词仍使用上述引用标签，不能用素材 ID 指代" : ""}`;
    }).filter(Boolean);
    const semanticIdentity = versionedLinkedAssets.map((row) => `语义身份（仅用于理解，不代表已上传参考图）：${row.name ?? "未命名"}：${row.describe ?? ""}`).join("\n");
    validatePromptReferenceSelection(input.mode, [...Array(referenceCounts.image).fill("image"), ...Array(referenceCounts.video).fill("video"), ...Array(referenceCounts.audio).fill("audio")]);
    const compositionSnapshot = options.compose ? await options.compose({ db: trx, scriptDuration: sourceSnapshot.reduce((total, row) => total + (Number(row.duration) || 0), 0), referenceCount: referenceLabels.length }) : null;
    const promptInput = [
      compositionSnapshot ? `实际生成参数：${JSON.stringify(compositionSnapshot.context)}` : `模型：${input.model}；模式：${input.mode}；脚本总时长：${sourceSnapshot.reduce((total, row) => total + (Number(row.duration) || 0), 0)}秒；生成参数：${JSON.stringify(input.generation ?? {})}（旧调用未提供字段，不能猜测参数）`,
      `源分镜（必须覆盖当前轨道全部分镜）：\n${buildStoryboardVideoPrompt(sourceSnapshot)}`,
      semanticIdentity,
      selectedVisual.length ? `本次用户选择的视觉参考（仅这些素材会作为视觉输入）：\n${selectedVisual.join("\n")}` : "本次未选择视觉参考图，不能假定存在已上传参考图。",
    ].filter(Boolean).join("\n\n");
    const referenceSnapshot = { info: input.info, selectedStoryboards: versionedStoryboards, selectedAssets: versionedAssets, linkedAssets: versionedLinkedAssets, ...(input.modeIntentSnapshot ? { modeIntent: input.modeIntentSnapshot } : {}), ...(trustedAssets ? { trustedAssets } : {}) };
    const requestHash = hash({ requestIdentityHash, sourceSnapshot, referenceSnapshot });
    const active = await trx(JOBS).where({ projectId, scriptId, trackId }).whereIn("state", ["queued", "running"]).first();
    if (active) throw new VideoPromptJobError("CONFLICT", "当前轨道已有提示词任务正在生成");
    const now = Date.now();
    const row = { id: `vprompt-${hash({ projectId, scriptId, trackId, idempotencyKey }).slice(0, 40)}`, projectId, scriptId, trackId, model: input.model, mode: input.mode, idempotencyKey, requestHash, requestIdentityHash, state: "queued", trackVersion: expectedVersion, sourceSnapshot: JSON.stringify(sourceSnapshot), referenceSnapshot: JSON.stringify(referenceSnapshot), compositionSnapshot: compositionSnapshot ? JSON.stringify(compositionSnapshot) : null, referenceLabels: JSON.stringify(referenceLabels), promptInput, resultPrompt: null, reason: null, createdAt: now, updatedAt: now };
    await trx(JOBS).insert(row);
    await trx("o_videoTrack").where({ id: trackId, projectId, scriptId }).update({ state: "生成中", reason: null });
    return { job: toJob(row), reused: false };
  });
}

/** Resolve a failed pre-claim validation without touching unrelated tracks. */
export async function markVideoPromptPreparationFailed(db: Knex, input: Pick<VideoPromptJobInput, "projectId" | "scriptId" | "trackId">, reason: string): Promise<void> {
  await ensureVideoPromptJobSchema(db);
  await db.transaction(async (trx) => {
    const track = await trx("o_videoTrack").where({ projectId: input.projectId, scriptId: input.scriptId, id: input.trackId }).forUpdate().first();
    if (!track || !(await trx("o_script").where({ id: input.scriptId, projectId: input.projectId }).first())) return;
    const active = await trx(JOBS).where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId }).whereIn("state", ["queued", "running"]).first();
    if (active) return;
    const now = Date.now();
    const failureKey = `preflight:${hash({ ...input, reason }).slice(0, 100)}`;
    await trx(JOBS).insert({
      id: `vprompt-failed-${hash({ ...input, reason }).slice(0, 40)}`, projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId,
      model: "", mode: "", idempotencyKey: failureKey, requestHash: hash({ ...input, reason }), requestIdentityHash: hash(input), state: "failed", trackVersion: Number((await getCreativeState(trx, "track", input.trackId, input.projectId)).version), sourceSnapshot: JSON.stringify([]), referenceSnapshot: JSON.stringify({}), promptInput: "", resultPrompt: null, reason: reason.slice(0, 4000), createdAt: now, updatedAt: now,
    }).onConflict(["projectId", "scriptId", "trackId", "idempotencyKey"]).ignore();
    await trx("o_videoTrack").where({ projectId: input.projectId, scriptId: input.scriptId, id: input.trackId, state: "生成中" }).update({ state: "生成失败", reason: reason.slice(0, 4000) });
  });
}

export async function executeVideoPromptJob(db: Knex, jobId: string, generate: (job: VideoPromptJob) => Promise<string | { prompt: string; review: VideoPromptReviewReport }>): Promise<VideoPromptJob> {
  let active = executing.get(db);
  if (!active) { active = new Map(); executing.set(db, active); }
  const current = active.get(jobId);
  if (current) return current;
  const promise = executeVideoPromptJobOnce(db, jobId, generate);
  active.set(jobId, promise);
  try { return await promise; } finally { active.delete(jobId); }
}

async function executeVideoPromptJobOnce(db: Knex, jobId: string, generate: (job: VideoPromptJob) => Promise<string | { prompt: string; review: VideoPromptReviewReport }>): Promise<VideoPromptJob> {
  await ensureVideoPromptJobSchema(db);
  const claimed = await db.transaction(async (trx) => {
    const row = await trx(JOBS).where({ id: jobId }).forUpdate().first();
    if (!row) throw new VideoPromptJobError("NOT_FOUND", "提示词任务不存在");
    if (row.state === "succeeded" || row.state === "failed" || row.state === "running") return { job: toJob(row), started: false };
    await trx(JOBS).where({ id: jobId, state: "queued" }).update({ state: "running", updatedAt: Date.now() });
    return { job: toJob({ ...row, state: "running" }), started: true };
  });
  if (!claimed.started) return claimed.job;
  try {
    const generated = await generate(claimed.job);
    const resultPrompt = typeof generated === "string" ? generated : generated.prompt;
    const promptReview = typeof generated === "string" ? null : generated.review;
    if (typeof resultPrompt !== "string" || !resultPrompt.trim()) throw new VideoPromptJobError("INVALID_INPUT", "模型未返回有效提示词");
    if (promptReview) await db(JOBS).where({ id: claimed.job.id, state: "running" }).update({ reviewReport: JSON.stringify(promptReview), reviewBinding: promptReviewBinding(claimed.job, resultPrompt) });
    // Generated drafts must preserve deterministic source content; semantic uncertainty remains visible.
    assertVideoPromptDialogue(buildStoryboardVideoPrompt(claimed.job.sourceSnapshot), resultPrompt, ((claimed.job.referenceSnapshot as any)?.linkedAssets ?? []).filter((item: any) => item.type === "role").map((item: any) => String(item.name ?? "")));
    const invalidReference = deterministicPromptFindings(claimed.job, resultPrompt).find((finding) => ["INVALID_REFERENCE_LABEL", "SPEAKER_CHANGED", "OFFSCREEN_SPEECH_CHANGED"].includes(finding.code));
    if (invalidReference) throw new VideoPromptJobError("INVALID_INPUT", invalidReference.message);

    return await db.transaction(async (trx) => {
      await lockProjectTransaction(trx, claimed.job.projectId);
      const current = await trx("o_videoTrack").where({ id: claimed.job.trackId, projectId: claimed.job.projectId, scriptId: claimed.job.scriptId }).forUpdate().first();
      const state = await getCreativeState(trx, "track", claimed.job.trackId, claimed.job.projectId);
      const row = await trx(JOBS).where({ id: claimed.job.id }).forUpdate().first();
      if (!current || !row) throw new VideoPromptJobError("NOT_FOUND", "提示词任务或轨道不存在");
      const currentSourceRows = await trx("o_storyboard").where({ projectId: claimed.job.projectId, scriptId: claimed.job.scriptId, trackId: claimed.job.trackId }).orderBy("index").orderBy("id").select("id", "prompt", "videoDesc", "duration");
      const currentSourceStates = currentSourceRows.length ? await trx("ext_entity_state").where({ projectId: claimed.job.projectId, entityType: "storyboard" }).whereIn("entityId", currentSourceRows.map((item) => Number(item.id))).select("entityId", "version") : [];
      const currentSources = currentSourceRows.map((item) => ({ ...item, version: Number(currentSourceStates.find((state) => Number(state.entityId) === Number(item.id))?.version ?? 0) }));
      const savedReferences = (claimed.job.referenceSnapshot && typeof claimed.job.referenceSnapshot === "object" ? claimed.job.referenceSnapshot : {}) as { info?: Array<{ id: number; sources: string }>; selectedStoryboards?: unknown[]; selectedAssets?: unknown[]; linkedAssets?: unknown[]; modeIntent?: { modeIntent: VideoModeIntent; revision: number } };
      const currentReferences = await currentPromptReferences(trx, claimed.job.projectId, claimed.job.scriptId, currentSources, { ...savedReferences, ...(isVolcengineTrustedModel(claimed.job.model) ? { trustedAssets: (savedReferences as any).trustedAssets ?? [] } : {}) }, claimed.job.trackId);
      const locked = await trx("ext_entity_state").where({ projectId: claimed.job.projectId, entityType: "storyboard", locked: 1 }).whereIn("entityId", claimed.job.sourceSnapshot.map((item) => item.id)).first();
      const sourceChanged = hash(currentSources) !== hash(claimed.job.sourceSnapshot);
      const referencesChanged = hash(currentReferences) !== hash(savedReferences);
      if (state.version !== claimed.job.trackVersion || locked || sourceChanged || referencesChanged) {
        const reason = sourceChanged || referencesChanged
          ? "源分镜或参考身份已变化，已保留当前内容；晚到的生成结果保存在任务记录中，未自动采用"
          : "轨道已被人工修改，已保留人工提示词；晚到的生成结果保存在任务记录中，未自动采用";
        await trx(JOBS).where({ id: claimed.job.id }).update({ state: "failed", resultPrompt, reason, updatedAt: Date.now() });
        await trx("o_videoTrack").where({ id: claimed.job.trackId, projectId: claimed.job.projectId, scriptId: claimed.job.scriptId }).where("state", "生成中").update({ state: "生成失败", reason });
        return { ...claimed.job, state: "failed", resultPrompt, reason };
      }
      await advanceCreativeState(trx, { entityType: "track", entityId: claimed.job.trackId, projectId: claimed.job.projectId, expectedVersion: claimed.job.trackVersion, actor: { kind: "system", id: `video-prompt:${claimed.job.id}` } });
      await trx("o_videoTrack").where({ id: claimed.job.trackId, projectId: claimed.job.projectId, scriptId: claimed.job.scriptId }).update({ prompt: resultPrompt, state: "已完成", reason: null });
      const promptModeRevision = (claimed.job.referenceSnapshot as any)?.modeIntent?.revision;
      await acknowledgeVideoPromptReferences(trx, { projectId: claimed.job.projectId, scriptId: claimed.job.scriptId, trackId: claimed.job.trackId, expectedRevision: Number.isSafeInteger(promptModeRevision) ? Number(promptModeRevision) : undefined }, `video-prompt:${claimed.job.id}`);
      await trx(JOBS).where({ id: claimed.job.id }).update({ state: "succeeded", resultPrompt, reason: null, updatedAt: Date.now() });
      return { ...claimed.job, state: "succeeded", resultPrompt, promptReview, reason: null };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await db.transaction(async (trx) => {
      await trx(JOBS).where({ id: claimed.job.id, state: "running" }).update({ state: "failed", reason, updatedAt: Date.now() });
      await trx("o_videoTrack").where({ id: claimed.job.trackId, projectId: claimed.job.projectId, scriptId: claimed.job.scriptId, state: "生成中" }).update({ state: "生成失败", reason });
    });
    throw error;
  }
}
