import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { lockProjectTransaction } from "../../lib/dbTransaction";
import { advanceCreativeState, ensureCreativeWorkspaceSchema, getCreativeState } from "../creativeWorkspace";
import type { TrustedActor } from "../productionState";

const MUTATIONS = "ext_novel_event_mutations";
const SOURCES = "ext_novel_event_sources";
const id = z.number().int().positive();
const version = z.number().int().nonnegative();
const key = z.string().min(8).max(150).regex(/^[\w:.-]+$/);

export const requestNovelEventRunSchema = z.object({
  projectId: id,
  novelIds: z.array(id).min(1).max(2000),
  expectedVersions: z.record(z.string(), version),
  idempotencyKey: key,
  concurrentCount: z.number().int().min(1).max(2).optional(),
}).strict();

const deleteEventSchema = z.object({ projectId: id, id, expectedVersion: version, idempotencyKey: key }).strict();
const batchDeleteEventSchema = z.object({
  projectId: id,
  items: z.array(z.object({ id, expectedVersion: version }).strict()).min(1).max(1000),
  idempotencyKey: key,
}).strict();
const readEventSchema = z.object({ projectId: id, page: z.number().int().min(1), limit: z.number().int().min(1).max(200), search: z.string().max(500).optional() }).strict();

export class NovelEventWorkspaceError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "PROJECT_MISMATCH" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "RUNTIME_UNAVAILABLE" | "MODEL_FAILED",
    message: string,
    public readonly status = 400,
  ) { super(message); this.name = "NovelEventWorkspaceError"; }
}

export interface NovelEventChapterSnapshot {
  id: number;
  expectedVersion: number;
  contentHash: string;
}

export interface NovelEventRunContext {
  phase: "novelEvents";
  projectId: number;
  chapters: NovelEventChapterSnapshot[];
  concurrency: number;
  maxOutputTokensPerChapter: number;
}

export interface NovelEventRunReceipt {
  run: { id: string; status: string; version: number; intent?: unknown; [key: string]: unknown };
  reused: boolean;
}

export type NovelEventRunStarter = (input: {
  requestedBy: number;
  idempotencyKey: string;
  context: NovelEventRunContext;
  limits: { maxModelCalls: number; maxToolSteps: number; maxOutputTokens: number; maxImageGenerations: 0; maxVideoGenerations: 0 };
}) => Promise<NovelEventRunReceipt>;
export type NovelEventRunLookup = (requestedBy: number, idempotencyKey: string) => Promise<NovelEventRunReceipt | undefined>;

let novelEventRunStarter: NovelEventRunStarter | undefined;
let novelEventRunLookup: NovelEventRunLookup | undefined;

/** Application bootstrap installs the builtin-runtime adapter without coupling HTTP routes to it. */
export function configureNovelEventRunStarter(starter: NovelEventRunStarter, lookup?: NovelEventRunLookup): void {
  novelEventRunStarter = starter;
  novelEventRunLookup = lookup;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new NovelEventWorkspaceError("INVALID_INPUT", parsed.error.issues.map((issue) => issue.message).join("; "));
  return parsed.data;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((name) => `${JSON.stringify(name)}:${canonical(record[name])}`).join(",")}}`;
}

const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export function novelContentHash(chapter: { chapterIndex?: unknown; reel?: unknown; chapter?: unknown; chapterData?: unknown }): string {
  return digest({
    chapterIndex: Number(chapter.chapterIndex),
    reel: String(chapter.reel ?? ""),
    chapter: String(chapter.chapter ?? ""),
    chapterData: String(chapter.chapterData ?? ""),
  });
}

export async function ensureNovelEventWorkspaceSchema(db: Knex): Promise<void> {
  await ensureCreativeWorkspaceSchema(db);
  if (!(await db.schema.hasTable(MUTATIONS))) {
    await db.schema.createTable(MUTATIONS, (table) => {
      table.text("actorId").notNullable();
      table.bigInteger("projectId").notNullable();
      table.text("idempotencyKey").notNullable();
      table.text("requestHash").notNullable();
      table.text("result").notNullable();
      table.bigInteger("createdAt").notNullable();
      table.primary(["actorId", "projectId", "idempotencyKey"]);
    });
  }
  if (!(await db.schema.hasTable(SOURCES))) {
    await db.schema.createTable(SOURCES, (table) => {
      table.bigInteger("eventId").primary().references("id").inTable("o_event").onDelete("CASCADE");
      table.bigInteger("novelId").notNullable().references("id").inTable("o_novel").onDelete("CASCADE").index();
      table.bigInteger("projectId").notNullable().references("id").inTable("o_project").onDelete("CASCADE").index();
      table.integer("sourceVersion").notNullable();
      table.text("contentHash").notNullable();
      table.uuid("runId").notNullable();
      table.bigInteger("createdAt").notNullable();
    });
  }
}

function normalizedRequest(raw: unknown) {
  const input = parse(requestNovelEventRunSchema, raw);
  const novelIds = [...new Set(input.novelIds)].sort((left, right) => left - right);
  if (novelIds.length !== input.novelIds.length) throw new NovelEventWorkspaceError("INVALID_INPUT", "同一章节不能重复选择");
  const expectedKeys = Object.keys(input.expectedVersions).filter((value) => /^\d+$/.test(value)).map(Number).sort((a, b) => a - b);
  if (canonical(expectedKeys) !== canonical(novelIds)) throw new NovelEventWorkspaceError("INVALID_INPUT", "每个选中章节必须且只能提供一个最新版本");
  return { ...input, novelIds, concurrentCount: Math.min(2, input.concurrentCount ?? 2) };
}

export async function prepareNovelEventRunContext(db: Knex, raw: unknown): Promise<NovelEventRunContext> {
  const input = normalizedRequest(raw);
  await ensureNovelEventWorkspaceSchema(db);
  if (!(await db("o_project").where({ id: input.projectId }).first("id"))) throw new NovelEventWorkspaceError("NOT_FOUND", "项目不存在", 404);
  const rows = await db("o_novel").where({ projectId: input.projectId }).whereIn("id", input.novelIds).orderBy("chapterIndex").orderBy("id");
  if (rows.length !== input.novelIds.length) throw new NovelEventWorkspaceError("PROJECT_MISMATCH", "选中的原文不属于当前项目", 403);
  const chapters: NovelEventChapterSnapshot[] = [];
  for (const row of rows) {
    const chapterId = Number(row.id);
    const currentVersion = (await getCreativeState(db, "novel", chapterId, input.projectId)).version;
    if (currentVersion !== input.expectedVersions[String(chapterId)]) throw new NovelEventWorkspaceError("VERSION_CONFLICT", "原文已被修改，请刷新后重试", 409);
    chapters.push({ id: chapterId, expectedVersion: currentVersion, contentHash: novelContentHash(row) });
  }
  return { phase: "novelEvents", projectId: input.projectId, chapters, concurrency: input.concurrentCount, maxOutputTokensPerChapter: 1200 };
}

function parsedIntent(value: unknown): { phase?: unknown; context?: { chapters?: Array<{ id?: unknown }> } } | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return undefined; }
  }
  return typeof value === "object" ? value as { phase?: unknown; context?: { chapters?: Array<{ id?: unknown }> } } : undefined;
}

/** Runs inside BuiltinAgentRuntime.beforeCreate, before the run becomes visible to a worker. */
export async function initializeNovelEventRun(trx: Knex.Transaction, context: NovelEventRunContext): Promise<void> {
  if (!context || context.phase !== "novelEvents" || !Number.isSafeInteger(context.projectId) || !Array.isArray(context.chapters) || !context.chapters.length) {
    throw new NovelEventWorkspaceError("INVALID_INPUT", "事件提取运行缺少有效项目或章节范围");
  }
  await lockProjectTransaction(trx, context.projectId);
  const requestedIds = context.chapters.map((chapter) => Number(chapter.id));
  if (new Set(requestedIds).size !== requestedIds.length || requestedIds.some((chapterId) => !Number.isSafeInteger(chapterId) || chapterId <= 0)) {
    throw new NovelEventWorkspaceError("INVALID_INPUT", "事件提取章节范围无效");
  }
  const rows = await trx("o_novel").where({ projectId: context.projectId }).whereIn("id", requestedIds);
  if (rows.length !== requestedIds.length) throw new NovelEventWorkspaceError("PROJECT_MISMATCH", "选中的原文不属于当前项目", 403);
  for (const snapshot of context.chapters) {
    const row = rows.find((candidate) => Number(candidate.id) === snapshot.id);
    const currentVersion = row ? (await getCreativeState(trx, "novel", snapshot.id, context.projectId)).version : -1;
    if (!row || currentVersion !== snapshot.expectedVersion || novelContentHash(row) !== snapshot.contentHash) {
      throw new NovelEventWorkspaceError("VERSION_CONFLICT", "原文已被修改，请刷新后重试", 409);
    }
  }
  const requested = new Set(requestedIds);
  const activeRuns = await trx("ext_builtin_runs").where({ projectId: context.projectId })
    .whereIn("status", ["queued", "running", "waiting_human", "paused"]).select("id", "intent");
  for (const row of activeRuns) {
    const intent = parsedIntent(row.intent);
    if (intent?.phase !== "novelEvents" || !Array.isArray(intent.context?.chapters)) continue;
    const overlap = intent.context.chapters.map((chapter) => Number(chapter.id)).filter((chapterId) => requested.has(chapterId));
    if (overlap.length) throw new NovelEventWorkspaceError("VERSION_CONFLICT", `章节 ${overlap.join("、")} 已有进行中的事件提取，请等待或接管该运行`, 409);
  }
  await trx("o_novel").where({ projectId: context.projectId }).whereIn("id", requestedIds).update({ eventState: 0, errorReason: null });
}

function requestIdentity(input: ReturnType<typeof normalizedRequest>) {
  return input.novelIds.map((chapterId) => ({ id: chapterId, version: input.expectedVersions[String(chapterId)] }));
}

export async function startNovelEventRun(db: Knex, raw: unknown, requestedBy: number): Promise<NovelEventRunReceipt> {
  const input = normalizedRequest(raw);
  if (novelEventRunLookup) {
    const existing = await novelEventRunLookup(requestedBy, input.idempotencyKey);
    if (existing) {
      const intent = existing.run.intent as { phase?: unknown; context?: Partial<NovelEventRunContext> } | undefined;
      const actual = Array.isArray(intent?.context?.chapters)
        ? intent.context.chapters.map((chapter) => ({ id: Number(chapter.id), version: Number(chapter.expectedVersion) })).sort((a, b) => a.id - b.id)
        : [];
      if (intent?.phase !== "novelEvents" || Number(intent.context?.projectId) !== input.projectId || canonical(actual) !== canonical(requestIdentity(input))) {
        throw new NovelEventWorkspaceError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同的事件提取请求", 409);
      }
      return { ...existing, reused: true };
    }
  }
  const context = await prepareNovelEventRunContext(db, input);
  if (!novelEventRunStarter) throw new NovelEventWorkspaceError("RUNTIME_UNAVAILABLE", "事件提取运行时尚未接入", 503);
  const count = context.chapters.length;
  const receipt = await novelEventRunStarter({
    requestedBy,
    idempotencyKey: input.idempotencyKey,
    context,
    limits: {
      maxModelCalls: count,
      maxToolSteps: count * 2 + 4,
      maxOutputTokens: Math.min(2_400_000, count * context.maxOutputTokensPerChapter),
      maxImageGenerations: 0,
      maxVideoGenerations: 0,
    },
  });
  return receipt;
}

function actorId(actor: TrustedActor): string {
  if (!actor?.id || !["human", "agent", "system"].includes(actor.kind)) throw new NovelEventWorkspaceError("INVALID_INPUT", "缺少可信操作身份");
  return actor.id;
}

async function eventOwnership(trx: Knex.Transaction | Knex, projectId: number, eventIds: readonly number[]) {
  const rows = await trx("o_eventChapter as link").join("o_novel as novel", "novel.id", "link.novelId")
    .whereIn("link.eventId", eventIds as number[]).select("link.eventId", "novel.projectId");
  const found = new Set(rows.filter((row) => Number(row.projectId) === projectId).map((row) => Number(row.eventId)));
  if (found.size !== eventIds.length || rows.some((row) => Number(row.projectId) !== projectId)) throw new NovelEventWorkspaceError("PROJECT_MISMATCH", "事件不属于当前项目", 403);
}

export async function readNovelEvents(db: Knex, raw: unknown) {
  const input = parse(readEventSchema, raw);
  let base = db("o_event as event").join("o_eventChapter as link", "link.eventId", "event.id").join("o_novel as novel", "novel.id", "link.novelId")
    .where("novel.projectId", input.projectId);
  if (input.search?.trim()) base = base.whereILike("event.name", `%${input.search.trim()}%`);
  const counted = await base.clone().countDistinct("event.id as total").first();
  const total = Number(counted?.total ?? 0);
  if (!total) return { list: [], total: 0 };
  const pageRows = await base.clone().distinct("event.id", "event.name", "event.detail", "event.createTime")
    .orderBy("event.createTime", "desc").orderBy("event.id", "desc").limit(input.limit).offset((input.page - 1) * input.limit);
  const ids = pageRows.map((row) => Number(row.id));
  const [links, states] = await Promise.all([
    db("o_eventChapter as link").join("o_novel as novel", "novel.id", "link.novelId").whereIn("link.eventId", ids)
      .where("novel.projectId", input.projectId).select("link.eventId", "novel.id as novelId", "novel.chapterIndex").orderBy("novel.chapterIndex").orderBy("novel.id"),
    db("ext_creative_state").where({ entityType: "event", projectId: input.projectId }).whereIn("entityId", ids),
  ]);
  return {
    list: pageRows.map((event) => ({
      id: Number(event.id), eventName: String(event.name ?? ""), detail: String(event.detail ?? ""), createTime: Number(event.createTime),
      chapters: links.filter((link) => Number(link.eventId) === Number(event.id)).map((link) => Number(link.chapterIndex)),
      novelIds: links.filter((link) => Number(link.eventId) === Number(event.id)).map((link) => Number(link.novelId)),
      version: Number(states.find((state) => Number(state.entityId) === Number(event.id))?.version ?? 0),
    })),
    total,
  };
}

export async function readNovelEventStates(db: Knex, projectId: number, novelIds: readonly number[]) {
  await ensureNovelEventWorkspaceSchema(db);
  const uniqueIds = [...new Set(novelIds.map(Number))];
  const rows = await db("o_novel").where({ projectId }).whereIn("id", uniqueIds)
    .select("id", "chapterIndex", "reel", "chapter", "chapterData", "event", "eventState", "errorReason");
  if (rows.length !== uniqueIds.length) throw new NovelEventWorkspaceError("PROJECT_MISMATCH", "原文不属于当前项目", 403);
  const sources = await db(SOURCES).where({ projectId }).whereIn("novelId", uniqueIds).orderBy("createdAt", "desc");
  return Promise.all(rows.map(async (row) => {
    const source = sources.find((item) => Number(item.novelId) === Number(row.id));
    if (!row.event || row.eventState === 0) return { id: Number(row.id), event: row.event, eventState: row.eventState, errorReason: row.errorReason };
    if (row.eventState === -1) return { id: Number(row.id), event: row.event, eventState: -1, errorReason: row.errorReason || "本次事件提取失败，已保留原事件" };
    const currentVersion = (await getCreativeState(db, "novel", Number(row.id), projectId)).version;
    const fresh = source && Number(source.sourceVersion) === currentVersion && String(source.contentHash) === novelContentHash(row);
    return fresh
      ? { id: Number(row.id), event: row.event, eventState: 1, errorReason: null }
      : { id: Number(row.id), event: row.event, eventState: -1, errorReason: source ? "原文已更新，现有事件来自旧版本，请重新提取" : "现有事件缺少来源版本，请重新提取后核对" };
  }));
}

async function mutationReceipt<T>(trx: Knex.Transaction, actor: string, projectId: number, idempotencyKey: string, requestHash: string): Promise<T | undefined> {
  const row = await trx(MUTATIONS).where({ actorId: actor, projectId, idempotencyKey }).first();
  if (!row) return undefined;
  if (row.requestHash !== requestHash) throw new NovelEventWorkspaceError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同的事件请求", 409);
  return JSON.parse(row.result) as T;
}

export async function deleteNovelEvents(db: Knex, raw: unknown, actor: TrustedActor) {
  const input = parse(batchDeleteEventSchema, raw);
  const who = actorId(actor);
  const items = [...input.items].sort((a, b) => a.id - b.id);
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new NovelEventWorkspaceError("INVALID_INPUT", "同一事件不能重复删除");
  const requestHash = digest({ ...input, items });
  await ensureNovelEventWorkspaceSchema(db);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const replay = await mutationReceipt<{ eventIds: number[]; deleted: true }>(trx, who, input.projectId, input.idempotencyKey, requestHash);
    if (replay) return { ...replay, reused: true };
    const eventIds = items.map((item) => item.id);
    await eventOwnership(trx, input.projectId, eventIds);
    for (const item of items) {
      const current = await getCreativeState(trx, "event", item.id, input.projectId);
      if (current.version !== item.expectedVersion) throw new NovelEventWorkspaceError("VERSION_CONFLICT", "事件已被修改，请刷新后重试", 409);
    }
    await trx("o_eventChapter").whereIn("eventId", eventIds).delete();
    await trx(SOURCES).whereIn("eventId", eventIds).delete();
    await trx("o_event").whereIn("id", eventIds).delete();
    await trx("ext_creative_state").where({ entityType: "event", projectId: input.projectId }).whereIn("entityId", eventIds).delete();
    const result = { eventIds, deleted: true as const };
    await trx(MUTATIONS).insert({ actorId: who, projectId: input.projectId, idempotencyKey: input.idempotencyKey, requestHash, result: JSON.stringify(result), createdAt: Date.now() });
    return { ...result, reused: false };
  });
}

export async function deleteNovelEvent(db: Knex, raw: unknown, actor: TrustedActor) {
  const input = parse(deleteEventSchema, raw);
  const result = await deleteNovelEvents(db, { projectId: input.projectId, items: [{ id: input.id, expectedVersion: input.expectedVersion }], idempotencyKey: input.idempotencyKey }, actor);
  return { eventId: result.eventIds[0], deleted: true as const, reused: result.reused };
}

export async function loadNovelEventPrompt(db: Knex, fallback: () => Promise<string | undefined>): Promise<string> {
  const configured = await db("o_prompt").where({ type: "eventExtraction" }).first();
  const prompt = configured?.useData || configured?.data || await fallback();
  if (!prompt || !String(prompt).trim()) throw new NovelEventWorkspaceError("INVALID_INPUT", "未配置事件提取提示词");
  return String(prompt);
}

export { advanceCreativeState, getCreativeState };
