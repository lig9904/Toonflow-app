import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { isPostgres, lockProjectTransaction } from "@/lib/dbTransaction";
import type { TrustedActor } from "@/services/productionState";

const TIMELINES = "ext_edit_timelines";
const MUTATIONS = "ext_edit_timeline_mutations";
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

export class EditTimelineError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "INVALID_INPUT" | "PROJECT_MISMATCH" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT",
    message: string,
    public readonly current?: EditTimelineSnapshot,
  ) {
    super(message);
    this.name = "EditTimelineError";
  }
}

export interface EditTimelineSnapshot {
  projectId: number;
  scriptId: number;
  version: number;
  timeline: Record<string, unknown>;
  updatedBy: string | null;
  updatedAt: number | null;
  exists: boolean;
}

const id = z.number().int().positive();
const version = z.number().int().nonnegative();
const idempotencyKey = z.string().min(8).max(150).regex(/^[\w:.-]+$/);
const clipSchema = z.object({
  id: z.string().trim().min(1).max(200),
  startTime: z.number().finite().nonnegative(),
  endTime: z.number().finite().nonnegative(),
}).passthrough().superRefine((clip, context) => {
  if (clip.endTime <= clip.startTime) context.addIssue({ code: "custom", message: "clip endTime 必须大于 startTime", path: ["endTime"] });
  if (clip.endTime > 24 * 60 * 60) context.addIssue({ code: "custom", message: "clip 时间不能超过 24 小时", path: ["endTime"] });
});
const trackSchema = z.object({
  id: z.string().trim().min(1).max(200),
  type: z.string().trim().min(1).max(80),
  clips: z.array(clipSchema).max(2000),
}).passthrough();
const timelineSchema = z.object({
  tracks: z.array(trackSchema).max(100),
}).passthrough().superRefine((timeline, context) => {
  const ids = new Set<string>();
  let maxEnd = 0;
  let clipCount = 0;
  for (const track of timeline.tracks) {
    if (ids.has(track.id)) context.addIssue({ code: "custom", message: `重复的 track id: ${track.id}`, path: ["tracks"] });
    ids.add(track.id);
    for (const clip of track.clips) {
      clipCount += 1;
      if (ids.has(clip.id)) context.addIssue({ code: "custom", message: `重复的 clip id: ${clip.id}`, path: ["tracks"] });
      ids.add(clip.id);
      maxEnd = Math.max(maxEnd, clip.endTime);
    }
  }
  if (clipCount > 10000) context.addIssue({ code: "custom", message: "时间线 clip 总数不能超过 10000", path: ["tracks"] });
  if (maxEnd > 24 * 60 * 60) context.addIssue({ code: "custom", message: "时间线不能超过 24 小时", path: ["tracks"] });
});
const saveSchema = z.object({
  projectId: id,
  scriptId: id,
  expectedVersion: version,
  idempotencyKey,
  timeline: timelineSchema,
}).strict();

export type SaveEditTimelineInput = z.infer<typeof saveSchema>;

function asNumber(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new EditTimelineError("INVALID_INPUT", `${field} 无效`);
  return n;
}

function validateActor(actor: TrustedActor): void {
  if (!actor || actor.kind !== "human" || typeof actor.id !== "string" || !/^human:\d+$/.test(actor.id)) {
    throw new EditTimelineError("INVALID_INPUT", "缺少可信团队操作身份");
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

function json(value: unknown): string {
  const text = JSON.stringify(canonicalize(value));
  if (!text || Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) throw new EditTimelineError("INVALID_INPUT", "时间线内容过大");
  return text;
}

function parseTimeline(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new EditTimelineError("INVALID_INPUT", "时间线内容不是有效 JSON");
  }
}

function snapshot(row: any, projectId: number, scriptId: number): EditTimelineSnapshot {
  return {
    projectId,
    scriptId,
    version: Number(row?.version ?? 0),
    timeline: row ? parseTimeline(row.timeline) : { tracks: [] },
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt == null ? null : Number(row.updatedAt),
    exists: Boolean(row),
  };
}

async function ensureTable(db: Knex, table: string, create: (schema: Knex.CreateTableBuilder) => void): Promise<void> {
  if (!(await db.schema.hasTable(table))) await db.schema.createTable(table, create);
}

/** Additive, lazy schema creation for desktop SQLite and PostgreSQL tests. */
export async function ensureEditTimelineSchema(db: Knex): Promise<void> {
  const run = async (trx: Knex.Transaction) => {
    if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["toonflow:edit-timeline-schema"]);
    await ensureTable(trx, TIMELINES, (table) => {
      table.bigInteger("projectId").notNullable();
      table.bigInteger("scriptId").notNullable();
      table.bigInteger("version").notNullable().defaultTo(0);
      table.text("timeline").notNullable();
      table.text("updatedBy");
      table.bigInteger("updatedAt");
      table.bigInteger("createdAt").notNullable();
      table.primary(["projectId", "scriptId"]);
      table.index(["projectId"]);
    });
    await ensureTable(trx, MUTATIONS, (table) => {
      table.text("actorId").notNullable();
      table.bigInteger("projectId").notNullable();
      table.bigInteger("scriptId").notNullable();
      table.text("idempotencyKey").notNullable();
      table.text("requestHash").notNullable();
      table.text("result").notNullable();
      table.bigInteger("createdAt").notNullable();
      table.primary(["actorId", "projectId", "scriptId", "idempotencyKey"]);
    });
  };
  if ((db as any).isTransaction) return run(db as unknown as Knex.Transaction);
  await db.transaction(run);
}

async function assertScript(db: Knex, projectId: number, scriptId: number): Promise<void> {
  const row = await db("o_script").where({ id: scriptId }).first();
  if (!row) throw new EditTimelineError("NOT_FOUND", "剧集不存在");
  if (Number(row.projectId) !== projectId) throw new EditTimelineError("PROJECT_MISMATCH", "剧集不属于当前项目");
}

export async function readEditTimeline(db: Knex, projectIdValue: unknown, scriptIdValue: unknown): Promise<EditTimelineSnapshot> {
  const projectId = asNumber(projectIdValue, "projectId");
  const scriptId = asNumber(scriptIdValue, "scriptId");
  await ensureEditTimelineSchema(db);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    await assertScript(trx, projectId, scriptId);
    const row = await trx(TIMELINES).where({ projectId, scriptId }).first();
    return snapshot(row, projectId, scriptId);
  });
}

export async function saveEditTimeline(db: Knex, raw: unknown, actor: TrustedActor): Promise<EditTimelineSnapshot & { replayed: boolean }> {
  validateActor(actor);
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) throw new EditTimelineError("INVALID_INPUT", parsed.error.issues.map((issue) => issue.message).join("; "));
  const data = parsed.data;
  const requestHash = createHash("sha256").update(json({ projectId: data.projectId, scriptId: data.scriptId, expectedVersion: data.expectedVersion, timeline: data.timeline })).digest("hex");
  await ensureEditTimelineSchema(db);

  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, data.projectId);
    await assertScript(trx, data.projectId, data.scriptId);
    const mutationKey = { actorId: actor.id, projectId: data.projectId, scriptId: data.scriptId, idempotencyKey: data.idempotencyKey };
    const previous = await trx(MUTATIONS).where(mutationKey).first();
    if (previous) {
      if (previous.requestHash !== requestHash) throw new EditTimelineError("IDEMPOTENCY_CONFLICT", "该操作编号已用于不同时间线内容");
      return { ...snapshot(JSON.parse(previous.result), data.projectId, data.scriptId), replayed: true };
    }

    const query = trx(TIMELINES).where({ projectId: data.projectId, scriptId: data.scriptId });
    const currentRow = isPostgres(trx) ? await query.forUpdate().first() : await query.first();
    const current = snapshot(currentRow, data.projectId, data.scriptId);
    if (current.version !== data.expectedVersion) {
      throw new EditTimelineError("VERSION_CONFLICT", "时间线已被其他成员修改，请保留本地编辑并重新载入", current);
    }
    const now = Date.now();
    const next = { projectId: data.projectId, scriptId: data.scriptId, version: current.version + 1, timeline: json(data.timeline), updatedBy: actor.id, updatedAt: now, createdAt: currentRow?.createdAt ?? now };
    if (currentRow) await trx(TIMELINES).where({ projectId: data.projectId, scriptId: data.scriptId }).update(next);
    else await trx(TIMELINES).insert(next);
    const result = snapshot(next, data.projectId, data.scriptId);
    await trx(MUTATIONS).insert({ ...mutationKey, requestHash, result: JSON.stringify(result), createdAt: now });
    return { ...result, replayed: false };
  });
}
