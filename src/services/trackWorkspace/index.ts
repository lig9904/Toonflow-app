import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { lockProjectTransaction } from "@/lib/dbTransaction";
import { insertRowsReturningIds } from "@/lib/insertRows";
import { advanceCreativeState, CreativeWorkspaceError, ensureCreativeWorkspaceSchema, getCreativeState } from "@/services/creativeWorkspace";
import { ensureProductionStateSchema, type TrustedActor } from "@/services/productionState";

const RECEIPTS = "ext_track_mutations";
const SUCCESS_STATES = new Set(["生成成功", "已完成"]);

export class TrackWorkspaceError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "PROJECT_MISMATCH" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "LOCKED" | "ACTIVE_JOB",
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
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    const replay = await receipt<any>(trx, who, projectId, idempotencyKey, requestHash);
    if (replay) return { ...replay, reused: true };
    const track = await mutationContext(trx, projectId, scriptId, trackId);
    await advance(trx, trackId, projectId, expectedVersion, actor);
    const updated = await trx("o_videoTrack").where({ id: trackId, projectId, scriptId }).update({ [field]: value });
    if (updated !== 1) throw new TrackWorkspaceError("VERSION_CONFLICT", "轨道已被其他成员修改，请刷新后重试");
    const result = { track: { ...(await view(trx, track)), [field]: value } };
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
    await trx("ext_video_jobs").where({ projectId, scriptId, trackId }).delete();
    await trx("o_video").where({ projectId, scriptId, videoTrackId: trackId }).delete();
    const removed = await trx("o_videoTrack").where({ id: trackId, projectId, scriptId }).delete();
    if (removed !== 1) throw new TrackWorkspaceError("VERSION_CONFLICT", "轨道已被其他成员修改，请刷新后重试");
    await trx("ext_creative_state").where({ entityType: "track", entityId: trackId, projectId }).delete();
    const result = { id: trackId, deletedVideoCount: videos.length, message: "视频段删除成功" };
    await saveReceipt(trx, who, projectId, idempotencyKey, requestHash, result);
    return { ...result, reused: false };
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
