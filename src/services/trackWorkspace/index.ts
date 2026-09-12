import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { acknowledgeVideoPromptReferences, ensureVideoModeIntentSchema } from "../videoModeResolution";
import { lockProjectTransaction } from "@/lib/dbTransaction";
import { insertRowsReturningIds } from "@/lib/insertRows";
import { advanceCreativeState, CreativeWorkspaceError, ensureCreativeWorkspaceSchema, getCreativeState } from "@/services/creativeWorkspace";
import { ensureProductionStateSchema, type TrustedActor } from "@/services/productionState";
import { assertTrackWritable } from "../storyboardTrackIndependence";

const RECEIPTS = "ext_track_mutations";
const SUCCESS_STATES = new Set(["生成成功", "已完成"]);

export class TrackWorkspaceError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "PROJECT_MISMATCH" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "LOCKED" | "ACTIVE_JOB" | "MIGRATION_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "TrackWorkspaceError";
  }
}

function positive(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TrackWorkspaceError("INVALID_INPUT", `${name} 无效`);
  return parsed;
}

function version(value: unknown): number {
  if (typeof value !== "number") throw new TrackWorkspaceError("INVALID_INPUT", "expectedVersion 无效");
  const parsed = value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TrackWorkspaceError("INVALID_INPUT", "expectedVersion 无效");
  return parsed;
}

function key(input: any): string {
  if (input?.idempotencyKey && input?.mutationKey && input.idempotencyKey !== input.mutationKey) throw new TrackWorkspaceError("IDEMPOTENCY_CONFLICT", "操作编号冲突");
  const value = input?.idempotencyKey ?? input?.mutationKey;
  if (typeof value !== "string" || !/^[\w:.-]{8,150}$/.test(value)) throw new TrackWorkspaceError("INVALID_INPUT", "缺少有效操作编号");
  return value;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([name]) => name !== "idempotencyKey" && name !== "mutationKey")
    .sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [name, stable(item)]));
  return value;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

export async function ensureTrackWorkspaceSchema(db: Knex): Promise<void> {
  await ensureCreativeWorkspaceSchema(db);
  await ensureProductionStateSchema(db);
  if (!(await db.schema.hasTable(RECEIPTS))) {
    await db.schema.createTable(RECEIPTS, (table) => {
      table.text("actorId").notNullable();
      table.bigInteger("projectId").notNullable();
      table.text("idempotencyKey").notNullable();
      table.text("requestHash").notNullable();
      table.text("result").notNullable();
      table.bigInteger("createdAt").notNullable();
      table.primary(["actorId", "projectId", "idempotencyKey"]);
    });
  }
}

async function receipt<T>(db: Knex | Knex.Transaction, actorId: string, projectId: number, idempotencyKey: string, requestHash: string): Promise<T | undefined> {
  const row = await db(RECEIPTS).where({ actorId, projectId, idempotencyKey }).first();
  if (!row) return undefined;
  if (row.requestHash !== requestHash) throw new TrackWorkspaceError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同内容");
  return JSON.parse(row.result) as T;
}

async function saveReceipt(trx: Knex.Transaction, actorId: string, projectId: number, idempotencyKey: string, requestHash: string, result: unknown): Promise<void> {
  await trx(RECEIPTS).insert({ actorId, projectId, idempotencyKey, requestHash, result: JSON.stringify(result), createdAt: Date.now() });
}

function actorId(actor: TrustedActor): string {
  if (!actor?.id || actor.kind !== "human") throw new TrackWorkspaceError("INVALID_INPUT", "缺少可信操作身份");
  return actor.id;
}

async function mutationContext(trx: Knex.Transaction, projectId: number, scriptId: number, trackId: number): Promise<any> {
  if (!(await trx("o_script").where({ id: scriptId, projectId }).first())) throw new TrackWorkspaceError("PROJECT_MISMATCH", "剧集不属于当前项目");
  const track = await trx("o_videoTrack").where({ id: trackId, projectId, scriptId }).first();
  if (!track) throw new TrackWorkspaceError("PROJECT_MISMATCH", "视频轨道不属于当前项目或剧集");
  await assertTrackWritable(trx, projectId, trackId).catch((error) => { throw new TrackWorkspaceError("INVALID_INPUT", error instanceof Error ? error.message : "历史归档轨道不可修改"); });
  const locked = await trx("o_storyboard as storyboard")
    .join("ext_entity_state as state", function joinState() {
      this.on("state.entityType", "=", trx.raw("?", ["storyboard"]))
        .andOn("state.entityId", "=", "storyboard.id")
        .andOn("state.locked", "=", trx.raw("?", [1]));
    })
    .where({ "storyboard.projectId": projectId, "storyboard.scriptId": scriptId, "storyboard.trackId": trackId })
    .first();
  if (locked) throw new TrackWorkspaceError("LOCKED", "锁定分镜使用了该视频轨道");
  return track;
}

async function advance(trx: Knex.Transaction, trackId: number, projectId: number, expectedVersion: number, actor: TrustedActor): Promise<void> {
  try {
    await advanceCreativeState(trx, { entityType: "track", entityId: trackId, projectId, expectedVersion, actor });
  } catch (error) {
    if (error instanceof CreativeWorkspaceError) throw new TrackWorkspaceError(error.code, error.message);
    throw error;
  }
}

async function view(db: Knex | Knex.Transaction, track: any): Promise<any> {
  return {
    id: Number(track.id),
    projectId: Number(track.projectId),
    scriptId: Number(track.scriptId),
    videoId: track.videoId == null ? null : Number(track.videoId),
    version: (await getCreativeState(db as Knex, "track", Number(track.id), Number(track.projectId))).version,
  };
}

function duration(value: unknown): number {
  if (typeof value !== "number") throw new TrackWorkspaceError("INVALID_INPUT", "duration 无效");
  const parsed = value;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 86_400) throw new TrackWorkspaceError("INVALID_INPUT", "duration 无效");
  return parsed;
}

function prompt(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_000_000) throw new TrackWorkspaceError("INVALID_INPUT", "prompt 无效");
  return value;
}

async function assertScript(trx: Knex.Transaction, projectId: number, scriptId: number): Promise<void> {
  if (!(await trx("o_project").where({ id: projectId }).first())) throw new TrackWorkspaceError("NOT_FOUND", "项目不存在");
  if (!(await trx("o_script").where({ id: scriptId, projectId }).first())) throw new TrackWorkspaceError("PROJECT_MISMATCH", "剧集不属于当前项目");
}

export async function createTrack(db: Knex, input: any, actor: TrustedActor): Promise<any> {
  const projectId = positive(input.projectId, "projectId");
  const scriptId = positive(input.scriptId, "scriptId");
  const trackDuration = duration(input.duration ?? 0);
  const idempotencyKey = key(input);
  const who = actorId(actor);
  const requestHash = hash({ projectId, scriptId, duration: trackDuration });
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    const replay = await receipt<any>(trx, who, projectId, idempotencyKey, requestHash);
    if (replay) return { ...replay, reused: true };
    await assertScript(trx, projectId, scriptId);
    const [trackId] = await insertRowsReturningIds(trx, "o_videoTrack", { projectId, scriptId, duration: trackDuration });
    const track = await trx("o_videoTrack").where({ id: trackId, projectId, scriptId }).first();
    const result = { track: await view(trx, track), reused: false };
    await saveReceipt(trx, who, projectId, idempotencyKey, requestHash, result);
    return result;
  });
}

async function updateTrackField(db: Knex, input: any, actor: TrustedActor, field: "prompt" | "duration", value: string | number): Promise<any> {
  const projectId = positive(input.projectId, "projectId");
  const scriptId = positive(input.scriptId, "scriptId");
  const trackId = positive(input.id ?? input.trackId, "trackId");
  const expectedVersion = version(input.expectedVersion);
  const idempotencyKey = key(input);
  const who = actorId(actor);
  const requestHash = hash({ projectId, scriptId, trackId, expectedVersion, field, value });
  if (field === "prompt") await ensureVideoModeIntentSchema(db);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    const replay = await receipt<any>(trx, who, projectId, idempotencyKey, requestHash);
    if (replay) return { ...replay, reused: true };
    const track = await mutationContext(trx, projectId, scriptId, trackId);
    await advance(trx, trackId, projectId, expectedVersion, actor);
    const patch = field === "prompt"
      ? { prompt: value, state: String(value).trim() ? "已完成" : "未生成", reason: null }
      : { duration: value };
    const updated = await trx("o_videoTrack").where({ id: trackId, projectId, scriptId }).update(patch);
    if (updated !== 1) throw new TrackWorkspaceError("VERSION_CONFLICT", "轨道已被其他成员修改，请刷新后重试");
    if (field === "prompt") await acknowledgeVideoPromptReferences(trx, { projectId, scriptId, trackId, expectedRevision: Number.isSafeInteger(input.modeIntentRevision) ? Number(input.modeIntentRevision) : undefined }, who);
    const result = { track: { ...(await view(trx, track)), ...patch } };
    await saveReceipt(trx, who, projectId, idempotencyKey, requestHash, result);
    return { ...result, reused: false };
  });
}

export async function updateTrackPrompt(db: Knex, input: any, actor: TrustedActor): Promise<any> {
  return updateTrackField(db, input, actor, "prompt", prompt(input.prompt));
}

export async function updateTrackDuration(db: Knex, input: any, actor: TrustedActor): Promise<any> {
  return updateTrackField(db, input, actor, "duration", duration(input.duration));
}

const TERMINAL_VIDEO_JOB_STATES = new Set(["SUCCEEDED", "FAILED"]);
const TERMINAL_VIDEO_STATES = new Set(["生成成功", "已完成", "生成失败"]);

async function assertNoActiveTrackWork(trx: Knex.Transaction, projectId: number, scriptId: number, trackId: number, storyboardVersions: Record<number, number> = {}): Promise<void> {
  if (await trx.schema.hasTable("ext_video_jobs") && await trx("ext_video_jobs").where({ projectId, scriptId, trackId }).whereNotIn("status", [...TERMINAL_VIDEO_JOB_STATES]).first()) throw new TrackWorkspaceError("ACTIVE_JOB", "视频任务仍在运行或状态不确定");
  if (await trx("o_video").where({ projectId, scriptId, videoTrackId: trackId }).whereNotIn("state", [...TERMINAL_VIDEO_STATES]).first()) throw new TrackWorkspaceError("ACTIVE_JOB", "视频结果仍在生成或状态不确定");
  if (await trx.schema.hasTable("ext_video_prompt_jobs") && await trx("ext_video_prompt_jobs").where({ projectId, scriptId, trackId }).whereIn("state", ["queued", "running"]).first()) throw new TrackWorkspaceError("ACTIVE_JOB", "视频提示词任务仍在运行");
  if (await trx.schema.hasTable("ext_builtin_runs") && await trx("ext_builtin_runs").where({ projectId, scriptId }).whereIn("status", ["queued", "running", "waiting_human", "paused"]).first()) throw new TrackWorkspaceError("ACTIVE_JOB", "内置 Agent 仍在运行、暂停或等待确认");
  const storyboardIds = Object.keys(storyboardVersions).map(Number);
  if (storyboardIds.length && await trx.schema.hasTable("ext_image_job_bindings")) {
    const [imageWork, states] = await Promise.all([trx("ext_image_job_bindings as binding").join("ext_image_jobs as job", "job.id", "binding.jobId").where({ "binding.projectId": projectId, "binding.targetKind": "storyboard", "job.projectId": projectId }).whereIn("binding.targetId", storyboardIds).whereNotIn("job.status", [...TERMINAL_VIDEO_JOB_STATES]).select("binding.targetId", "binding.claimVersion", "binding.claimToken"), trx("ext_entity_state").where({ projectId, entityType: "storyboard" }).whereIn("entityId", storyboardIds)]);
    if (imageWork.some((row) => { const state = states.find((item) => Number(item.entityId) === Number(row.targetId)); return Number(row.claimVersion) === Number(state?.version ?? 0) && String(row.claimToken ?? "") !== "" && row.claimToken === state?.internalMutation; })) throw new TrackWorkspaceError("ACTIVE_JOB", "分镜图片任务仍在运行或状态不确定");
  }
  if (storyboardIds.length && await trx.schema.hasTable("ext_image_jobs")) {
    const jobs = await trx("ext_image_jobs").where({ projectId }).whereNotIn("status", [...TERMINAL_VIDEO_JOB_STATES]).select("payload");
    if (jobs.some((job) => { try { const target = JSON.parse(job.payload)?.context?.target; return target?.kind === "storyboard" && storyboardIds.includes(Number(target.id)) && Number(target.expectedVersion) === storyboardVersions[Number(target.id)]; } catch { return false; } })) throw new TrackWorkspaceError("ACTIVE_JOB", "分镜图片任务仍在运行或状态不确定");
  }
  if (await trx.schema.hasTable("ext_volcengine_asset_uploads") && await trx("ext_volcengine_asset_uploads").where({ projectId, scriptId, targetKind: "storyboard" }).whereIn("targetId", storyboardIds).where((query) => query.whereIn("status", ["submission_unknown", "processing"]).orWhere((nested) => nested.where({ status: "active", bindStatus: "pending" }))).first()) throw new TrackWorkspaceError("ACTIVE_JOB", "分镜素材上传或绑定仍在进行");
}

export async function deleteTrack(db: Knex, input: any, actor: TrustedActor): Promise<any> {
  const projectId = positive(input.projectId, "projectId");
  const scriptId = positive(input.scriptId, "scriptId");
  const trackId = positive(input.id ?? input.trackId, "trackId");
  const expectedVersion = version(input.expectedVersion);
  const idempotencyKey = key(input);
  const who = actorId(actor);
  const requestHash = hash({ projectId, scriptId, trackId, expectedVersion });
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    const replay = await receipt<any>(trx, who, projectId, idempotencyKey, requestHash);
    if (replay) return { ...replay, reused: true };
    const track = await mutationContext(trx, projectId, scriptId, trackId);

    const references = await trx("o_storyboard").where({ trackId }).select("id", "projectId", "scriptId");
    if (references.some((row) => Number(row.projectId) !== projectId || Number(row.scriptId) !== scriptId)) {
      throw new TrackWorkspaceError("PROJECT_MISMATCH", "轨道存在跨项目或跨剧集的异常引用");
    }
    if (references.length) throw new TrackWorkspaceError("INVALID_INPUT", "轨道仍被分镜引用，请先解除分镜与轨道的关联");
    await assertNoActiveTrackWork(trx, projectId, scriptId, trackId);

    const videos = await trx("o_video").where({ videoTrackId: trackId }).select("id", "projectId", "scriptId", "state");
    if (videos.some((row) => Number(row.projectId) !== projectId || Number(row.scriptId) !== scriptId)) {
      throw new TrackWorkspaceError("PROJECT_MISMATCH", "轨道存在跨项目或跨剧集的异常视频记录");
    }
    const jobs = await trx("ext_video_jobs").where({ trackId }).select("id", "projectId", "scriptId", "status");
    if (jobs.some((row) => Number(row.projectId) !== projectId || Number(row.scriptId) !== scriptId)) {
      throw new TrackWorkspaceError("PROJECT_MISMATCH", "轨道存在跨项目或跨剧集的异常任务记录");
    }
    if (jobs.some((row) => !TERMINAL_VIDEO_JOB_STATES.has(String(row.status))) || videos.some((row) => !TERMINAL_VIDEO_STATES.has(String(row.state)))) {
      throw new TrackWorkspaceError("ACTIVE_JOB", "轨道存在进行中或状态不确定的视频任务，不能删除");
    }

    await advance(trx, trackId, projectId, expectedVersion, actor);
    const jobIds = jobs.map((row) => Number(row.id));
    if (jobIds.length && await trx.schema.hasTable("ext_video_mode_submission_claims")) await trx("ext_video_mode_submission_claims").whereIn("jobId", jobIds).delete();
    await trx("ext_video_jobs").where({ projectId, scriptId, trackId }).delete();
    if (await trx.schema.hasTable("ext_video_prompt_jobs")) await trx("ext_video_prompt_jobs").where({ projectId, scriptId, trackId }).delete();
    if (await trx.schema.hasTable("ext_video_mode_intents")) await trx("ext_video_mode_intents").where({ projectId, scriptId, trackId }).delete();
    await trx("o_video").where({ projectId, scriptId, videoTrackId: trackId }).delete();
    const removed = await trx("o_videoTrack").where({ id: trackId, projectId, scriptId }).delete();
    if (removed !== 1) throw new TrackWorkspaceError("VERSION_CONFLICT", "轨道已被其他成员修改，请刷新后重试");
    await trx("ext_creative_state").where({ entityType: "track", entityId: trackId, projectId }).delete();
    const result = { id: trackId, deletedVideoCount: videos.length, message: "视频段删除成功" };
    await saveReceipt(trx, who, projectId, idempotencyKey, requestHash, result);
    return { ...result, reused: false };
  });
}

interface StoryboardDeleteItem {
  scriptId: number;
  storyboardId: number;
  trackId: number | null;
  expectedTrackVersion: number | null;
  expectedStoryboardVersion: number;
}

interface PreparedStoryboardDelete extends StoryboardDeleteItem {
  board: any;
  track: any | null;
  videoIds: number[];
  imageJobIds: number[];
}

function storyboardDeleteItem(input: any): StoryboardDeleteItem {
  const trackId = input?.trackId == null ? null : positive(input.trackId, "trackId");
  const expectedTrackVersion = input?.expectedTrackVersion == null ? null : version(input.expectedTrackVersion);
  if ((trackId == null) !== (expectedTrackVersion == null)) throw new TrackWorkspaceError("INVALID_INPUT", "关联片段删除必须同时提供 trackId 和 expectedTrackVersion；孤儿分镜必须都为 null");
  return {
    scriptId: positive(input?.scriptId, "scriptId"),
    storyboardId: positive(input?.storyboardId, "storyboardId"),
    trackId,
    expectedTrackVersion,
    expectedStoryboardVersion: version(input?.expectedStoryboardVersion),
  };
}

async function prepareStoryboardDelete(trx: Knex.Transaction, projectId: number, item: StoryboardDeleteItem): Promise<PreparedStoryboardDelete> {
  await assertScript(trx, projectId, item.scriptId);
  const board = await trx("o_storyboard").where({ id: item.storyboardId }).first();
  if (!board || Number(board.projectId) !== projectId || Number(board.scriptId) !== item.scriptId) throw new TrackWorkspaceError("PROJECT_MISMATCH", "分镜不属于指定项目或剧集");
  const actualTrackId = board.trackId == null ? null : Number(board.trackId);
  if (actualTrackId !== item.trackId) throw new TrackWorkspaceError("VERSION_CONFLICT", "分镜关联片段已变化，请刷新");
  const boardState = await trx("ext_entity_state").where({ projectId, entityType: "storyboard", entityId: item.storyboardId }).first();
  if (boardState?.locked) throw new TrackWorkspaceError("LOCKED", "锁定分镜不能删除");
  if (Number(boardState?.version ?? 0) !== item.expectedStoryboardVersion) throw new TrackWorkspaceError("VERSION_CONFLICT", "分镜已变化，请刷新");

  let track: any | null = null;
  let videoIds: number[] = [];
  if (item.trackId != null) {
    track = await mutationContext(trx, projectId, item.scriptId, item.trackId);
    const boards = await trx("o_storyboard").where({ trackId: item.trackId }).orderBy("id");
    if (boards.some((row) => Number(row.projectId) !== projectId || Number(row.scriptId) !== item.scriptId)) throw new TrackWorkspaceError("PROJECT_MISMATCH", "轨道存在跨项目或跨剧集分镜引用");
    if (boards.length !== 1 || Number(boards[0].id) !== item.storyboardId) throw new TrackWorkspaceError("MIGRATION_REQUIRED", "该历史片段仍关联多条分镜，请先完成一镜一片段迁移");
    const currentTrackState = await getCreativeState(trx, "track", item.trackId, projectId);
    if (currentTrackState.version !== item.expectedTrackVersion) throw new TrackWorkspaceError("VERSION_CONFLICT", "视频片段已变化，请刷新");
    const videos = await trx("o_video").where({ videoTrackId: item.trackId }).select("id", "projectId", "scriptId", "state");
    if (videos.some((row) => Number(row.projectId) !== projectId || Number(row.scriptId) !== item.scriptId)) throw new TrackWorkspaceError("PROJECT_MISMATCH", "轨道存在跨项目或跨剧集的视频记录");
    const videoJobs = await trx.schema.hasTable("ext_video_jobs") ? await trx("ext_video_jobs").where({ trackId: item.trackId }).select("projectId", "scriptId") : [];
    if (videoJobs.some((row) => Number(row.projectId) !== projectId || Number(row.scriptId) !== item.scriptId)) throw new TrackWorkspaceError("PROJECT_MISMATCH", "轨道存在跨项目或跨剧集的视频任务");
    videoIds = videos.map((row) => Number(row.id));
  }
  await assertNoActiveTrackWork(trx, projectId, item.scriptId, item.trackId ?? 0, { [item.storyboardId]: item.expectedStoryboardVersion });

  let imageJobIds: number[] = [];
  if (await trx.schema.hasTable("ext_image_job_bindings")) {
    imageJobIds = (await trx("ext_image_job_bindings").where({ projectId, targetKind: "storyboard", targetId: item.storyboardId }).select("jobId")).map((row) => Number(row.jobId));
    if (imageJobIds.length && await trx.schema.hasTable("ext_image_jobs")) {
      const jobs = await trx("ext_image_jobs").whereIn("id", imageJobIds).select("id", "projectId");
      if (jobs.length !== new Set(imageJobIds).size || jobs.some((job) => Number(job.projectId) !== projectId)) throw new TrackWorkspaceError("PROJECT_MISMATCH", "图片任务不属于当前项目");
      const shared = await trx("ext_image_job_bindings").whereIn("jobId", imageJobIds).whereNot({ projectId, targetKind: "storyboard", targetId: String(item.storyboardId) }).first();
      if (shared) throw new TrackWorkspaceError("PROJECT_MISMATCH", "图片任务存在跨目标异常绑定，未执行删除");
    }
  }
  return { ...item, board, track, videoIds, imageJobIds };
}

async function applyStoryboardDelete(trx: Knex.Transaction, projectId: number, item: PreparedStoryboardDelete, actor: TrustedActor): Promise<{ storyboardId: number; trackId: number | null; deletedVideoCount: number }> {
  if (item.trackId != null) await advance(trx, item.trackId, projectId, item.expectedTrackVersion!, actor);
  if (item.trackId != null) {
    if (await trx.schema.hasTable("ext_video_jobs")) await trx("ext_video_jobs").where({ projectId, scriptId: item.scriptId, trackId: item.trackId }).delete();
    if (await trx.schema.hasTable("ext_video_prompt_jobs")) await trx("ext_video_prompt_jobs").where({ projectId, scriptId: item.scriptId, trackId: item.trackId }).delete();
    if (await trx.schema.hasTable("ext_video_mode_intents")) await trx("ext_video_mode_intents").where({ projectId, scriptId: item.scriptId, trackId: item.trackId }).delete();
    if (await trx.schema.hasTable("ext_video_mode_submission_claims")) await trx("ext_video_mode_submission_claims").where({ projectId, scriptId: item.scriptId, trackId: item.trackId }).delete();
  }
  if (await trx.schema.hasTable("ext_image_job_bindings")) await trx("ext_image_job_bindings").where({ projectId, targetKind: "storyboard", targetId: item.storyboardId }).delete();
  if (item.imageJobIds.length && await trx.schema.hasTable("ext_image_jobs")) await trx("ext_image_jobs").where({ projectId }).whereIn("id", item.imageJobIds).delete();
  if (await trx.schema.hasTable("ext_image_reviews")) await trx("ext_image_reviews").where({ projectId, targetKind: "storyboard", targetId: item.storyboardId }).delete();
  if (await trx.schema.hasTable("ext_volcengine_reference_sets")) {
    await trx("ext_volcengine_references").where({ projectId, targetKind: "storyboard", targetId: item.storyboardId }).delete();
    await trx("ext_volcengine_reference_sets").where({ projectId, targetKind: "storyboard", targetId: item.storyboardId }).delete();
  }
  await trx("o_assets2Storyboard").where({ storyboardId: item.storyboardId }).delete();
  if (item.trackId != null) await trx("o_video").where({ projectId, scriptId: item.scriptId, videoTrackId: item.trackId }).delete();
  const removedBoard = await trx("o_storyboard").where({ id: item.storyboardId, projectId, scriptId: item.scriptId, trackId: item.trackId }).delete();
  if (removedBoard !== 1) throw new TrackWorkspaceError("VERSION_CONFLICT", "分镜已被其他成员修改，请刷新");
  if (item.trackId != null) {
    const removedTrack = await trx("o_videoTrack").where({ id: item.trackId, projectId, scriptId: item.scriptId }).delete();
    if (removedTrack !== 1) throw new TrackWorkspaceError("VERSION_CONFLICT", "视频片段已被其他成员修改，请刷新");
  }
  const flowId = Number(item.board.flowId);
  if (Number.isSafeInteger(flowId) && flowId > 0 && !(await trx("o_storyboard").where({ flowId }).first()) && !(await trx("o_assets").where({ flowId }).first())) {
    await trx("o_imageFlow").where({ id: flowId }).delete();
    if (await trx.schema.hasTable("ext_image_flow_owners")) await trx("ext_image_flow_owners").where({ projectId, flowId }).delete();
  }
  await trx("ext_entity_state").where({ projectId, entityType: "storyboard", entityId: item.storyboardId }).delete();
  if (item.trackId != null) await trx("ext_creative_state").where({ projectId, entityType: "track", entityId: item.trackId }).delete();
  return { storyboardId: item.storyboardId, trackId: item.trackId, deletedVideoCount: item.videoIds.length };
}

async function deleteStoryboardItems(db: Knex, options: { projectId: number; items: StoryboardDeleteItem[]; idempotencyKey: string; requestHash: string }, actor: TrustedActor): Promise<any> {
  const who = actorId(actor);
  const replay = await receipt<any>(db, who, options.projectId, options.idempotencyKey, options.requestHash);
  if (replay) return { ...replay, reused: true };
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, options.projectId);
    const old = await receipt<any>(trx, who, options.projectId, options.idempotencyKey, options.requestHash);
    if (old) return { ...old, reused: true };
    const prepared: PreparedStoryboardDelete[] = [];
    for (const item of options.items) prepared.push(await prepareStoryboardDelete(trx, options.projectId, item));
    const items = [];
    for (const item of prepared) items.push(await applyStoryboardDelete(trx, options.projectId, item, actor));
    const result = {
      items,
      deletedStoryboardCount: items.length,
      deletedTrackCount: items.filter((item) => item.trackId != null).length,
      message: "分镜及关联片段记录已删除，NAS 历史文件已保留",
    };
    await saveReceipt(trx, who, options.projectId, options.idempotencyKey, options.requestHash, result);
    return { ...result, reused: false };
  });
}

export async function deleteStoryboardTrack(db: Knex, input: any, actor: TrustedActor): Promise<any> {
  await ensureTrackWorkspaceSchema(db);
  const projectId = positive(input.projectId, "projectId");
  const item = storyboardDeleteItem(input);
  if (item.trackId == null) throw new TrackWorkspaceError("INVALID_INPUT", "该接口仅用于删除已关联单镜片段");
  const idempotencyKey = key(input);
  const requestHash = hash({ action: "deleteStoryboardTrack", projectId, scriptId: item.scriptId, trackId: item.trackId, storyboardId: item.storyboardId, expectedTrackVersion: item.expectedTrackVersion, expectedStoryboardVersion: item.expectedStoryboardVersion });
  const result = await deleteStoryboardItems(db, { projectId, items: [item], idempotencyKey, requestHash }, actor);
  // Receipts written by the first single-delete implementation stored the
  // item directly. Preserve replay compatibility if such a receipt exists.
  if (!Array.isArray(result.items)) return result;
  return { ...result.items[0], message: result.message, reused: result.reused };
}

export async function batchDeleteStoryboardTracks(db: Knex, input: any, actor: TrustedActor): Promise<any> {
  await ensureTrackWorkspaceSchema(db);
  const projectId = positive(input?.projectId, "projectId");
  if (!Array.isArray(input?.items) || input.items.length < 1 || input.items.length > 100) throw new TrackWorkspaceError("INVALID_INPUT", "items 必须包含 1 到 100 条分镜");
  const items = input.items.map(storyboardDeleteItem).sort((left: StoryboardDeleteItem, right: StoryboardDeleteItem) => left.storyboardId - right.storyboardId);
  if (new Set(items.map((item: StoryboardDeleteItem) => item.storyboardId)).size !== items.length) throw new TrackWorkspaceError("INVALID_INPUT", "同一分镜不能重复删除");
  const linkedTrackIds = items.flatMap((item: StoryboardDeleteItem) => item.trackId == null ? [] : [item.trackId]);
  if (new Set(linkedTrackIds).size !== linkedTrackIds.length) throw new TrackWorkspaceError("INVALID_INPUT", "同一视频片段不能重复删除");
  const idempotencyKey = key(input);
  const requestHash = hash({ action: "batchDeleteStoryboardTracks", projectId, items });
  return deleteStoryboardItems(db, { projectId, items, idempotencyKey, requestHash }, actor);
}

export async function clearTrackVideos(db: Knex, input: any, actor: TrustedActor): Promise<any> {
  await ensureTrackWorkspaceSchema(db);
  const projectId = positive(input.projectId, "projectId"), scriptId = positive(input.scriptId, "scriptId"), trackId = positive(input.trackId, "trackId"), expectedVersion = version(input.expectedTrackVersion), idempotencyKey = key(input), who = actorId(actor), requestHash = hash({ action: "clearTrackVideos", projectId, scriptId, trackId, expectedVersion });
  const replay = await receipt<any>(db, who, projectId, idempotencyKey, requestHash); if (replay) return { ...replay, reused: true };
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId); const old = await receipt<any>(trx, who, projectId, idempotencyKey, requestHash); if (old) return { ...old, reused: true };
    const track = await mutationContext(trx, projectId, scriptId, trackId), boards = await trx("o_storyboard").where({ projectId, scriptId, trackId }).select("id");
    if (boards.length > 1) throw new TrackWorkspaceError("MIGRATION_REQUIRED", "该历史片段仍关联多条分镜，请先完成一镜一片段迁移");
    await assertNoActiveTrackWork(trx, projectId, scriptId, trackId);
    await advance(trx, trackId, projectId, expectedVersion, actor);
    const videos = await trx("o_video").where({ projectId, scriptId, videoTrackId: trackId }).select("id");
    const videoJobIds = await trx.schema.hasTable("ext_video_jobs") ? (await trx("ext_video_jobs").where({ projectId, scriptId, trackId }).select("id")).map((row) => Number(row.id)) : [];
    if (videoJobIds.length && await trx.schema.hasTable("ext_video_mode_submission_claims")) await trx("ext_video_mode_submission_claims").whereIn("jobId", videoJobIds).delete();
    if (await trx.schema.hasTable("ext_video_jobs")) await trx("ext_video_jobs").where({ projectId, scriptId, trackId }).delete();
    await trx("o_video").where({ projectId, scriptId, videoTrackId: trackId }).delete(); await trx("o_videoTrack").where({ id: trackId, projectId, scriptId }).update({ videoId: null, selectVideoId: null });
    const result = { trackId, clearedVideoCount: videos.length, track: await view(trx, { ...track, videoId: null }), message: "视频结果已清空，分镜、图片、人工提示词和参考素材已保留" }; await saveReceipt(trx, who, projectId, idempotencyKey, requestHash, result); return { ...result, reused: false };
  });
}

export async function getTrackSelection(db: Knex, input: { projectId: unknown; scriptId: unknown; trackId: unknown }): Promise<any> {
  const projectId = positive(input.projectId, "projectId");
  const scriptId = positive(input.scriptId, "scriptId");
  const trackId = positive(input.trackId, "trackId");
  const track = await db("o_videoTrack").where({ id: trackId, projectId, scriptId }).first();
  if (!track) throw new TrackWorkspaceError("PROJECT_MISMATCH", "视频轨道不属于当前项目或剧集");
  return view(db, track);
}

export async function selectTrackVideo(db: Knex, input: any, actor: TrustedActor): Promise<any> {
  const projectId = positive(input.projectId, "projectId");
  const scriptId = positive(input.scriptId, "scriptId");
  const trackId = positive(input.trackId, "trackId");
  const videoId = positive(input.videoId, "videoId");
  const expectedVersion = version(input.expectedVersion);
  const idempotencyKey = key(input);
  const who = actorId(actor);
  const requestHash = hash(input);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    const replay = await receipt<any>(trx, who, projectId, idempotencyKey, requestHash);
    if (replay) return { ...replay, reused: true };
    const track = await mutationContext(trx, projectId, scriptId, trackId);
    const candidate = await trx("o_video").where({ id: videoId, projectId, scriptId, videoTrackId: trackId }).first();
    if (!candidate) throw new TrackWorkspaceError("PROJECT_MISMATCH", "视频候选不属于当前项目、剧集或轨道");
    if (!SUCCESS_STATES.has(String(candidate.state)) || !candidate.filePath) throw new TrackWorkspaceError("INVALID_INPUT", "只能选择已成功且有文件的视频候选");
    await advance(trx, trackId, projectId, expectedVersion, actor);
    await trx("o_videoTrack").where({ id: trackId, projectId, scriptId }).update({ videoId });
    const result = { track: await view(trx, { ...track, videoId }), videoId };
    await saveReceipt(trx, who, projectId, idempotencyKey, requestHash, result);
    return { ...result, reused: false };
  });
}

export async function deleteTrackVideo(db: Knex, input: any, actor: TrustedActor): Promise<any> {
  const projectId = positive(input.projectId, "projectId");
  const scriptId = positive(input.scriptId, "scriptId");
  const trackId = positive(input.trackId, "trackId");
  const videoId = positive(input.id ?? input.videoId, "videoId");
  const expectedVersion = version(input.expectedVersion);
  const idempotencyKey = key(input);
  const who = actorId(actor);
  const requestHash = hash({ ...input, videoId, id: undefined });
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    const replay = await receipt<any>(trx, who, projectId, idempotencyKey, requestHash);
    if (replay) return { ...replay, reused: true };
    const track = await mutationContext(trx, projectId, scriptId, trackId);
    const candidate = await trx("o_video").where({ id: videoId, projectId, scriptId, videoTrackId: trackId }).first();
    if (!candidate) throw new TrackWorkspaceError("PROJECT_MISMATCH", "视频候选不属于当前项目、剧集或轨道");
    const job = await trx("ext_video_jobs").where({ videoId }).first();
    if (job && ["SUBMITTING", "SUBMITTED", "POLLING", "DOWNLOADING"].includes(String(job.status))) throw new TrackWorkspaceError("ACTIVE_JOB", "视频任务仍在运行，不能删除候选");
    await advance(trx, trackId, projectId, expectedVersion, actor);
    const wasSelected = Number(track.videoId) === videoId;
    if (wasSelected) await trx("o_videoTrack").where({ id: trackId, projectId, scriptId, videoId }).update({ videoId: null });
    if (job) await trx("ext_video_jobs").where({ videoId }).delete();
    await trx("o_video").where({ id: videoId, projectId, scriptId, videoTrackId: trackId }).delete();
    const result = { videoId, wasSelected, track: await view(trx, { ...track, videoId: wasSelected ? null : track.videoId }) };
    await saveReceipt(trx, who, projectId, idempotencyKey, requestHash, result);
    return { ...result, reused: false };
  });
}
