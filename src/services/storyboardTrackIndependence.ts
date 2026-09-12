import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { isPostgres, lockProjectTransaction } from "../lib/dbTransaction";
import { insertRowsReturningIds } from "../lib/insertRows";
import type { TrustedActor } from "./productionState";

const ARCHIVES = "ext_shared_track_archives";
const RECEIPTS = "ext_track_split_requests";
const activeRunStates = ["queued", "running", "waiting_human", "paused"];
const terminalJobStates = ["SUCCEEDED", "FAILED"];

export class StoryboardTrackIndependenceError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "PROJECT_MISMATCH" | "PLAN_STALE" | "MIGRATION_BLOCKED" | "IDEMPOTENCY_CONFLICT" | "ARCHIVED_TRACK", message: string, public readonly status = 400) { super(message); this.name = "StoryboardTrackIndependenceError"; }
}
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`; return JSON.stringify(value); }
const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");

export async function ensureStoryboardTrackIndependenceSchema(db: Knex): Promise<void> {
  await db.transaction(async (trx) => {
    if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", ["toonflow:storyboard-track-independence"]);
    if (!(await trx.schema.hasTable(ARCHIVES))) await trx.schema.createTable(ARCHIVES, (table) => { table.text("archiveId").primary(); table.bigInteger("projectId").notNullable(); table.bigInteger("scriptId").notNullable(); table.bigInteger("sourceTrackId").notNullable().unique(); table.text("storyboardIds").notNullable(); table.text("snapshot").notNullable(); table.text("planHash").notNullable(); table.text("archivedBy").notNullable(); table.bigInteger("archivedAt").notNullable(); table.index(["projectId", "scriptId"]); });
    if (!(await trx.schema.hasTable(RECEIPTS))) await trx.schema.createTable(RECEIPTS, (table) => { table.text("actorId"); table.bigInteger("projectId"); table.text("idempotencyKey"); table.text("requestHash"); table.text("result"); table.bigInteger("createdAt"); table.primary(["actorId", "projectId", "idempotencyKey"]); });
  });
}

export async function isTrackArchived(db: Knex | Knex.Transaction, projectId: number, trackId: number): Promise<boolean> {
  return await db.schema.hasTable(ARCHIVES) && Boolean(await db(ARCHIVES).where({ projectId, sourceTrackId: trackId }).first("archiveId"));
}
export async function assertTrackWritable(db: Knex | Knex.Transaction, projectId: number, trackId: number): Promise<void> {
  if (await isTrackArchived(db, projectId, trackId)) throw new StoryboardTrackIndependenceError("ARCHIVED_TRACK", "该轨道是历史共享片段归档，只能查看，不能继续修改或生成", 409);
}
export async function archivedTrackIds(db: Knex | Knex.Transaction, projectId: number, scriptId: number): Promise<number[]> {
  if (!(await db.schema.hasTable(ARCHIVES))) return [];
  return (await db(ARCHIVES).where({ projectId, scriptId }).select("sourceTrackId")).map((row) => Number(row.sourceTrackId));
}

async function buildPlan(db: Knex | Knex.Transaction, input: { projectId: number; scriptId?: number }) {
  const project = await db("o_project").where({ id: input.projectId }).first("id"); if (!project) throw new StoryboardTrackIndependenceError("PROJECT_MISMATCH", "项目不存在", 404);
  if (input.scriptId !== undefined && !(await db("o_script").where({ id: input.scriptId, projectId: input.projectId }).first())) throw new StoryboardTrackIndependenceError("PROJECT_MISMATCH", "剧集不属于当前项目", 403);
  const archiveRows = await db.schema.hasTable(ARCHIVES) ? await db(ARCHIVES).where({ projectId: input.projectId }).modify((query) => { if (input.scriptId !== undefined) query.where({ scriptId: input.scriptId }); }).select("sourceTrackId") : [];
  const archived = new Set(archiveRows.map((row: any) => Number(row.sourceTrackId)));
  let query = db("o_storyboard").where({ projectId: input.projectId }).whereNotNull("trackId"); if (input.scriptId !== undefined) query = query.where({ scriptId: input.scriptId });
  const boards = await query.orderBy("scriptId").orderBy("trackId").orderBy("index").orderBy("id");
  const groupsByTrack = new Map<number, any[]>(); for (const board of boards) if (!archived.has(Number(board.trackId))) groupsByTrack.set(Number(board.trackId), [...(groupsByTrack.get(Number(board.trackId)) ?? []), board]);
  const shared = [...groupsByTrack].filter(([, rows]) => rows.length > 1);
  const trackIds = shared.map(([trackId]) => trackId), boardIds = shared.flatMap(([, rows]) => rows.map((row) => Number(row.id)));
  const tracks = trackIds.length ? await db("o_videoTrack").where({ projectId: input.projectId }).whereIn("id", trackIds) : [];
  const allTrackBoards = trackIds.length ? await db("o_storyboard").whereIn("trackId", trackIds).select("id", "projectId", "scriptId", "trackId") : [];
  const trackStates = trackIds.length && await db.schema.hasTable("ext_creative_state") ? await db("ext_creative_state").where({ projectId: input.projectId, entityType: "track" }).whereIn("entityId", trackIds) : [];
  const boardStates = boardIds.length && await db.schema.hasTable("ext_entity_state") ? await db("ext_entity_state").where({ projectId: input.projectId, entityType: "storyboard" }).whereIn("entityId", boardIds) : [];
  const videoJobs = trackIds.length && await db.schema.hasTable("ext_video_jobs") ? await db("ext_video_jobs").whereIn("trackId", trackIds) : [];
  const promptJobs = trackIds.length && await db.schema.hasTable("ext_video_prompt_jobs") ? await db("ext_video_prompt_jobs").whereIn("trackId", trackIds) : [];
  const videos = trackIds.length ? await db("o_video").whereIn("videoTrackId", trackIds) : [];
  const imageBindings = boardIds.length && await db.schema.hasTable("ext_image_job_bindings") ? await db("ext_image_job_bindings as binding").join("ext_image_jobs as job", "job.id", "binding.jobId").where({ "binding.projectId": input.projectId, "binding.targetKind": "storyboard" }).whereIn("binding.targetId", boardIds).whereNotIn("job.status", terminalJobStates).select("binding.jobId", "binding.targetId", "binding.expectedVersion", "binding.claimVersion", "binding.claimToken", "job.status") : [];
  const activeImageJobs = boardIds.length && await db.schema.hasTable("ext_image_jobs") ? await db("ext_image_jobs").where({ projectId: input.projectId }).whereNotIn("status", terminalJobStates).select("id", "status", "payload") : [];
  let activeRunQuery = db("ext_builtin_runs").where({ projectId: input.projectId }).whereIn("status", activeRunStates); if (input.scriptId !== undefined) activeRunQuery = activeRunQuery.where({ scriptId: input.scriptId });
  const activeRuns = await db.schema.hasTable("ext_builtin_runs") ? await activeRunQuery.select("id", "scriptId", "status") : [];
  const modeSelections = trackIds.length && await db.schema.hasTable("ext_video_mode_intents") ? await db("ext_video_mode_intents").where({ projectId: input.projectId }).whereIn("trackId", trackIds) : [];
  const groups = shared.map(([trackId, rows]) => {
    const track = tracks.find((item) => Number(item.id) === trackId), reasons: string[] = [];
    const states = rows.map((board) => boardStates.find((state) => Number(state.entityId) === Number(board.id)));
    if (!track || Number(track.projectId) !== input.projectId || rows.some((board) => Number(board.scriptId) !== Number(track.scriptId))) reasons.push("轨道归属与分镜项目或剧集不一致");
    const allReferences = allTrackBoards.filter((board) => Number(board.trackId) === trackId);
    if (allReferences.length !== rows.length || allReferences.some((board) => Number(board.projectId) !== input.projectId || Number(board.scriptId) !== Number(rows[0].scriptId))) reasons.push("轨道存在跨项目或跨剧集分镜引用");
    if (states.some((state) => Boolean(state?.locked))) reasons.push("包含锁定分镜");
    if (rows.some((board) => String(board.state) === "生成中")) reasons.push("分镜图片仍在生成");
    const currentImageBindings = imageBindings.filter((binding) => rows.some((board, index) => Number(board.id) === Number(binding.targetId) && Number(binding.claimVersion) === Number(states[index]?.version ?? 0) && String(binding.claimToken ?? "") !== "" && binding.claimToken === states[index]?.internalMutation));
    const boundImageJobIds = new Set(imageBindings.map((binding) => Number(binding.jobId)));
    const currentUnboundImageJobs = activeImageJobs.filter((job) => !boundImageJobIds.has(Number(job.id))).filter((job) => { try { const payload = JSON.parse(job.payload), target = payload?.context?.target; return target?.kind === "storyboard" && rows.some((board, index) => Number(board.id) === Number(target.id) && Number(target.expectedVersion) === Number(states[index]?.version ?? 0)); } catch { return false; } });
    if (currentImageBindings.length || currentUnboundImageJobs.length) reasons.push("分镜图片任务仍在运行或状态不确定");
    if (videoJobs.some((job) => Number(job.trackId) === trackId && !terminalJobStates.includes(String(job.status)))) reasons.push("视频任务仍在运行或状态不确定");
    if (promptJobs.some((job) => Number(job.trackId) === trackId && ["queued", "running"].includes(String(job.state)))) reasons.push("视频提示词任务仍在运行");
    if (String(track?.state) === "生成中") reasons.push("轨道仍标记为生成中");
    if (activeRuns.some((run) => Number(run.scriptId) === Number(rows[0].scriptId))) reasons.push("内置 Agent 仍在运行、暂停或等待确认");
    const selection = modeSelections.find((item) => Number(item.trackId) === trackId), trackState = trackStates.find((state) => Number(state.entityId) === trackId);
    const staleBoundImageJobs = imageBindings.filter((binding) => rows.some((board, index) => Number(board.id) === Number(binding.targetId) && !(Number(binding.claimVersion) === Number(states[index]?.version ?? 0) && String(binding.claimToken ?? "") !== "" && binding.claimToken === states[index]?.internalMutation))).length;
    const staleUnboundImageJobs = activeImageJobs.filter((job) => !boundImageJobIds.has(Number(job.id))).filter((job) => { try { const payload = JSON.parse(job.payload), target = payload?.context?.target; return target?.kind === "storyboard" && rows.some((board, index) => Number(board.id) === Number(target.id) && Number(target.expectedVersion) !== Number(states[index]?.version ?? 0)); } catch { return false; } }).length;
    const snapshot = { track, trackVersion: Number(trackState?.version ?? 0), boards: rows.map((board, index) => ({ id: Number(board.id), index: board.index, duration: Number(board.duration) || 0, filePath: board.filePath ?? null, version: Number(states[index]?.version ?? 0), locked: Boolean(states[index]?.locked) })), videos: videos.filter((video) => Number(video.videoTrackId) === trackId).map((video) => ({ id: Number(video.id), state: video.state, filePath: video.filePath ?? null, errorReason: video.errorReason ?? "" })).sort((a, b) => a.id - b.id), videoJobs: videoJobs.filter((job) => Number(job.trackId) === trackId).map((job) => ({ id: Number(job.id), status: job.status, payloadHash: job.payloadHash })).sort((a, b) => a.id - b.id), promptJobs: promptJobs.filter((job) => Number(job.trackId) === trackId).map((job) => ({ id: String(job.id), state: job.state, requestHash: job.requestHash })).sort((a, b) => a.id.localeCompare(b.id)), ignoredStaleImageJobs: staleBoundImageJobs + staleUnboundImageJobs, selection: selection ? { revision: Number(selection.revision), modeIntent: selection.modeIntent, references: selection.references } : null };
    return { sourceTrackId: trackId, scriptId: Number(rows[0].scriptId), storyboardIds: rows.map((board) => Number(board.id)), status: reasons.length ? "blocked" as const : "splittable" as const, reasons, proposedTracks: rows.map((board) => ({ storyboardId: Number(board.id), duration: Number(board.duration) || 0 })), archive: { prompt: track?.prompt ?? "", videoCount: snapshot.videos.length, selectionRevision: selection ? Number(selection.revision) : 0 }, snapshot };
  });
  const payload = { projectId: input.projectId, scriptId: input.scriptId ?? null, groups, alreadyIndependentCount: [...groupsByTrack.values()].filter((rows) => rows.length === 1).length };
  return { ...payload, planHash: hash(payload), blocked: groups.some((group) => group.status === "blocked") };
}

export async function planIndependentStoryboardTracks(db: Knex, raw: unknown) {
  const input = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive().optional() }).strict().parse(raw), plan = await buildPlan(db, input);
  return { ...plan, groups: plan.groups.map(({ snapshot, ...group }) => ({ ...group, ignoredStaleImageJobs: snapshot.ignoredStaleImageJobs })) };
}

export async function applyIndependentStoryboardTracks(db: Knex, raw: unknown, actor: TrustedActor) {
  await ensureStoryboardTrackIndependenceSchema(db);
  const input = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive().optional(), planHash: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey: z.string().min(8).max(150).regex(/^[\w:.-]+$/) }).strict().parse(raw);
  const actorId = actor?.kind === "human" && actor.id ? actor.id : ""; if (!actorId) throw new StoryboardTrackIndependenceError("INVALID_INPUT", "缺少可信操作者");
  const requestHash = hash(input), receiptKey = { actorId, projectId: input.projectId, idempotencyKey: input.idempotencyKey };
  const replay = await db(RECEIPTS).where(receiptKey).first(); if (replay) { if (replay.requestHash !== requestHash) throw new StoryboardTrackIndependenceError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同迁移", 409); return { ...JSON.parse(replay.result), reused: true }; }
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const old = await trx(RECEIPTS).where(receiptKey).first(); if (old) { if (old.requestHash !== requestHash) throw new StoryboardTrackIndependenceError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同迁移", 409); return { ...JSON.parse(old.result), reused: true }; }
    const plan = await buildPlan(trx, input); if (plan.planHash !== input.planHash) throw new StoryboardTrackIndependenceError("PLAN_STALE", "分镜、轨道或任务状态已变化，请重新生成迁移计划", 409); if (plan.blocked) throw new StoryboardTrackIndependenceError("MIGRATION_BLOCKED", "迁移计划包含锁定或活动任务，请先处理阻断项", 409);
    const mappings: Array<{ storyboardId: number; oldTrackId: number; newTrackId: number }> = [];
    for (const group of plan.groups) {
      await trx(ARCHIVES).insert({ archiveId: randomUUID(), projectId: input.projectId, scriptId: group.scriptId, sourceTrackId: group.sourceTrackId, storyboardIds: JSON.stringify(group.storyboardIds), snapshot: JSON.stringify(group.snapshot), planHash: input.planHash, archivedBy: actorId, archivedAt: Date.now() });
      for (const board of group.snapshot.boards) {
        const [newTrackId] = await insertRowsReturningIds(trx, "o_videoTrack", { projectId: input.projectId, scriptId: group.scriptId, duration: board.duration, state: "未生成" });
        const updated = await trx("o_storyboard").where({ id: board.id, projectId: input.projectId, scriptId: group.scriptId, trackId: group.sourceTrackId }).update({ trackId: newTrackId });
        if (updated !== 1) throw new StoryboardTrackIndependenceError("PLAN_STALE", "分镜轨道绑定已变化，请重新生成迁移计划", 409);
        mappings.push({ storyboardId: board.id, oldTrackId: group.sourceTrackId, newTrackId });
      }
    }
    const result = { projectId: input.projectId, scriptId: input.scriptId ?? null, planHash: input.planHash, splitGroupCount: plan.groups.length, createdTrackCount: mappings.length, mappings };
    await trx(RECEIPTS).insert({ ...receiptKey, requestHash, result: JSON.stringify(result), createdAt: Date.now() }); return { ...result, reused: false };
  });
}

export async function listArchivedSharedTracks(db: Knex, projectId: number, scriptId: number) {
  if (!(await db.schema.hasTable(ARCHIVES))) return [];
  return (await db(ARCHIVES).where({ projectId, scriptId }).orderBy("archivedAt", "desc")).map((row) => { const snapshot = JSON.parse(row.snapshot), videos = snapshot.videos.map((video: any) => ({ id: Number(video.id), state: video.state, filePath: video.filePath, errorReason: video.errorReason ?? "" })); return { archiveId: row.archiveId, sourceTrackId: Number(row.sourceTrackId), storyboardIds: JSON.parse(row.storyboardIds), prompt: String(snapshot.track?.prompt ?? ""), selectionRevision: Number(snapshot.selection?.revision ?? 0), modeIntent: snapshot.selection?.modeIntent ? JSON.parse(snapshot.selection.modeIntent) : "auto", references: snapshot.selection?.references ? JSON.parse(snapshot.selection.references) : [], videoCount: videos.length, videos, archivedAt: Number(row.archivedAt) }; });
}
