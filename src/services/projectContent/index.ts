import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { isPostgres, lockProjectTransaction } from "../../lib/dbTransaction";
import { insertRowsReturningIds } from "../../lib/insertRows";
import { CreativeWorkspaceError, advanceCreativeState, ensureCreativeWorkspaceSchema, getCreativeState, readScriptWorkspace, saveScriptWorkspace, type ScriptWorkspace } from "../creativeWorkspace";
import type { TrustedActor } from "../productionState";
import { associateProjectWithTeam } from "../team";
import { listAccessibleProjects } from "../team/authorization";
import { projectConfigurationIssue, type ProjectConfigurationMetadata } from "./configuration";

const MUTATIONS = "ext_project_content_mutations";
const id = z.number().int().positive();
const ver = z.number().int().nonnegative();
const key = z.string().min(8).max(150).regex(/^[\w:.-]+$/);
const str = (max: number) => z.string().max(max);
export class ProjectContentError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "PROJECT_MISMATCH" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "ACTIVE_TASK" | "LOCKED", message: string) { super(message); this.name = "ProjectContentError"; }
}
export const projectFieldsSchema = z.object({
  projectType: str(200), name: str(500).trim().min(1), intro: str(100000), type: str(200), artStyle: str(500),
  directorManual: str(500), videoRatio: str(50), imageModel: str(500), videoModel: str(500), imageQuality: str(50), mode: str(200),
}).strict();
export const createProjectSchema = projectFieldsSchema.extend({ idempotencyKey: key }).strict();
export const updateProjectSchema = projectFieldsSchema.extend({ id, expectedVersion: ver, idempotencyKey: key }).strict();
const scriptBody = z.object({ name: str(500).trim().min(1), content: str(2000000), assets: z.array(id).max(10000).optional() }).strict();
export const createScriptSchema = scriptBody.extend({ projectId: id, expectedVersion: ver, idempotencyKey: key }).strict();
export const batchCreateScriptSchema = z.object({
  projectId: id, expectedVersion: ver, idempotencyKey: key,
  data: z.array(z.object({ scriptName: str(500).trim().min(1), scriptData: str(2000000), assets: z.array(id).max(10000).optional() }).strict()).min(1).max(200),
}).strict();
export const updateScriptSchema = scriptBody.extend({ id, projectId: id, expectedVersion: ver, workspaceExpectedVersion: ver, idempotencyKey: key }).strict();
const novelItem = z.object({ index: z.union([z.number(), z.string()]).optional(), reel: str(500), chapter: str(100000), chapterData: str(2000000) }).strict();
export const createNovelSchema = z.object({ projectId: id, idempotencyKey: key, processEvents: z.boolean(), data: z.array(novelItem).min(1).max(2000) }).strict();
export const updateNovelSchema = z.object({
  id, projectId: id, expectedVersion: ver, idempotencyKey: key,
  index: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]),
  reel: str(500), chapter: str(100000), chapterData: str(2000000), event: str(2000000).optional(),
}).strict();
export const deleteProjectSchema = z.object({ id, expectedVersion: ver, idempotencyKey: key }).strict();
export const deleteNovelSchema = z.object({ id, projectId: id, expectedVersion: ver, idempotencyKey: key }).strict();
export const deleteNovelsSchema = z.object({
  projectId: id,
  items: z.array(z.object({ id, expectedVersion: ver }).strict()).min(1).max(2000),
  idempotencyKey: key,
}).strict();
export const deleteScriptsSchema = z.object({
  projectId: id,
  ids: z.array(id).min(1).max(200),
  versions: z.array(z.object({ id, expectedVersion: ver }).strict()).min(1).max(200),
  workspaceExpectedVersion: ver,
  idempotencyKey: key,
}).strict();
export interface VersionedProject extends Record<string, unknown> { id: number; version: number; }
export interface VersionedNovel extends Record<string, unknown> { id: number; projectId: number; version: number; }

function actorId(actor: TrustedActor): string {
  if (!actor || !["human", "agent", "system"].includes(actor.kind) || typeof actor.id !== "string" || !actor.id.trim()) throw new ProjectContentError("INVALID_INPUT", "缺少可信操作身份");
  return actor.id;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProjectContentError("INVALID_INPUT", parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}
function mutationInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  if (input.idempotencyKey !== undefined && input.mutationKey !== undefined && input.idempotencyKey !== input.mutationKey) {
    throw new ProjectContentError("IDEMPOTENCY_CONFLICT", "idempotencyKey 与 mutationKey 不一致");
  }
  const normalized: Record<string, unknown> = { ...input, idempotencyKey: input.idempotencyKey ?? input.mutationKey };
  delete normalized.mutationKey;
  return normalized;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function getReceipt<T>(trx: Knex.Transaction, where: Record<string, unknown>, requestHash: string): Promise<T | undefined> {
  const row = await trx(MUTATIONS).where(where).first();
  if (!row) return undefined;
  if (row.requestHash !== requestHash) throw new ProjectContentError("IDEMPOTENCY_CONFLICT", "该操作编号已用于不同内容");
  return JSON.parse(row.result) as T;
}
const putReceipt = (trx: Knex.Transaction, where: Record<string, unknown>, requestHash: string, result: unknown) =>
  trx(MUTATIONS).insert({ ...where, requestHash, result: JSON.stringify(result), createdAt: Date.now() });

export async function ensureProjectContentSchema(db: Knex): Promise<void> {
  await ensureCreativeWorkspaceSchema(db);
  await db.transaction(async (trx) => {
    if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["toonflow:project-content-schema"]);
    if (!(await trx.schema.hasTable(MUTATIONS))) await trx.schema.createTable(MUTATIONS, (table) => {
      table.text("actorId").notNullable(); table.text("scope").notNullable(); table.text("idempotencyKey").notNullable();
      table.text("requestHash").notNullable(); table.text("result").notNullable(); table.bigInteger("createdAt").notNullable();
      table.primary(["actorId", "scope", "idempotencyKey"]);
    });
  });
}
async function projectView(db: Knex, projectId: number): Promise<VersionedProject> {
  const row = await db("o_project").where({ id: projectId }).first();
  if (!row) throw new ProjectContentError("NOT_FOUND", "项目不存在");
  return { ...row, id: Number(row.id), version: (await getCreativeState(db, "project", projectId, projectId)).version };
}
type ProjectConfigurationSource = ProjectConfigurationMetadata | (() => Promise<ProjectConfigurationMetadata>);

async function validateProjectConfiguration(input: z.infer<typeof projectFieldsSchema>, source?: ProjectConfigurationSource): Promise<void> {
  if (!source) return;
  const metadata = typeof source === "function" ? await source() : source;
  const issue = projectConfigurationIssue(input, metadata);
  if (issue) throw new ProjectContentError("INVALID_INPUT", issue);
}

export async function createProject(db: Knex, raw: unknown, ownerUserId: number, actor: TrustedActor, metadata?: ProjectConfigurationSource): Promise<{ projectId: number; reused: boolean; project: VersionedProject }> {
  const input = parse(createProjectSchema, mutationInput(raw)), owner = Number(ownerUserId), who = actorId(actor), requestHash = digest({ owner, ...input });
  if (!Number.isSafeInteger(owner) || owner <= 0) throw new ProjectContentError("INVALID_INPUT", "用户编号无效");
  return db.transaction(async (trx) => {
    if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["project-create:" + who + ":" + input.idempotencyKey]);
    const lookup = { actorId: who, scope: "project:create", idempotencyKey: input.idempotencyKey };
    const old = await getReceipt<{ projectId: number; project: VersionedProject }>(trx, lookup, requestHash);
    if (old) {
      if (!(await trx("o_project").where({ id: old.projectId }).first())) throw new ProjectContentError("IDEMPOTENCY_CONFLICT", "该创建操作的项目已被删除，请使用新的操作编号");
      return { ...old, reused: true };
    }
    await validateProjectConfiguration(input, metadata);
    const { idempotencyKey: omitted, ...fields } = input;
    const [projectId] = await insertRowsReturningIds(trx, "o_project", { ...fields, userId: owner, createTime: Date.now() });
    await associateProjectWithTeam(trx, projectId);
    await advanceCreativeState(trx, { entityType: "project", entityId: projectId, projectId, expectedVersion: 0, actor });
    const result = { projectId, project: await projectView(trx, projectId) };
    await putReceipt(trx, lookup, requestHash, result);
    return { ...result, reused: false };
  });
}
export async function updateProject(db: Knex, raw: unknown, actor: TrustedActor, metadata?: ProjectConfigurationSource): Promise<{ reused: boolean; project: VersionedProject }> {
  const input = parse(updateProjectSchema, mutationInput(raw)), who = actorId(actor), requestHash = digest(input);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.id);
    const lookup = { actorId: who, scope: "project:" + input.id + ":update", idempotencyKey: input.idempotencyKey };
    const old = await getReceipt<{ project: VersionedProject }>(trx, lookup, requestHash);
    if (old) {
      if (!(await trx("o_project").where({ id: input.id }).first())) throw new ProjectContentError("NOT_FOUND", "项目不存在");
      return { ...old, reused: true };
    }
    await validateProjectConfiguration(input, metadata);
    if (!(await trx("o_project").where({ id: input.id }).first())) throw new ProjectContentError("NOT_FOUND", "项目不存在");
    await advanceCreativeState(trx, { entityType: "project", entityId: input.id, projectId: input.id, expectedVersion: input.expectedVersion, actor });
    const { id: projectId, expectedVersion: ev, idempotencyKey: ik, ...fields } = input;
    await trx("o_project").where({ id: projectId }).update(fields);
    const result = { project: await projectView(trx, projectId) };
    await putReceipt(trx, lookup, requestHash, result);
    return { ...result, reused: false };
  });
}
export async function listProjects(db: Knex, userId: number): Promise<VersionedProject[]> {
  const rows = await listAccessibleProjects(db, userId) as any[];
  const states = rows.length ? await db("ext_creative_state").where({ entityType: "project" }).whereIn("entityId", rows.map((r) => r.id)) : [];
  return rows.map((row) => ({ ...row, id: Number(row.id), version: Number(states.find((s) => Number(s.entityId) === Number(row.id))?.version ?? 0) }));
}

export async function createScripts(db: Knex, raw: unknown, actor: TrustedActor): Promise<{ scriptIds: number[]; scripts: ScriptWorkspace["script"]; workspaceVersion: number; reused: boolean }> {
  const input = parse(batchCreateScriptSchema, mutationInput(raw)), who = actorId(actor);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const lookup = { actorId: who, scope: `project:${input.projectId}:scripts:create`, idempotencyKey: input.idempotencyKey };
    const requestHash = digest(input);
    const old = await getReceipt<{ scriptIds: number[]; scripts: ScriptWorkspace["script"]; workspaceVersion: number }>(trx, lookup, requestHash);
    if (old) return { ...old, reused: true };
    const workspace = await getCreativeState(trx, "scriptPlan", input.projectId, input.projectId);
    if (input.expectedVersion > workspace.version) throw new ProjectContentError("VERSION_CONFLICT", "工作区版本无效，请重新读取");
    // Independent additions serialize their order, without rejecting each other
    // just because another member added a different episode first.
    const saved = await saveScriptWorkspace(trx, {
      projectId: input.projectId, expectedVersion: workspace.version, mutationKey: input.idempotencyKey, actor,
      script: input.data.map((x) => ({ name: x.scriptName, content: x.scriptData, ...(x.assets === undefined ? {} : { assets: x.assets }) })),
    });
    const result = { scriptIds: saved.createdScriptIds, scripts: saved.script.filter((s) => saved.createdScriptIds.includes(s.id)), workspaceVersion: saved.version };
    await putReceipt(trx, lookup, requestHash, result);
    return { ...result, reused: false };
  });
}
export async function createScript(db: Knex, raw: unknown, actor: TrustedActor): Promise<{ scriptId: number; script: ScriptWorkspace["script"][number]; workspaceVersion: number; reused: boolean }> {
  const input = parse(createScriptSchema, mutationInput(raw));
  const out = await createScripts(db, { projectId: input.projectId, expectedVersion: input.expectedVersion, idempotencyKey: input.idempotencyKey, data: [{ scriptName: input.name, scriptData: input.content, ...(input.assets === undefined ? {} : { assets: input.assets }) }] }, actor);
  return { scriptId: out.scriptIds[0], script: out.scripts[0], workspaceVersion: out.workspaceVersion, reused: out.reused };
}
export async function updateScript(db: Knex, raw: unknown, actor: TrustedActor): Promise<{ script: ScriptWorkspace["script"][number]; workspaceVersion: number; reused: boolean }> {
  const input = parse(updateScriptSchema, mutationInput(raw)), who = actorId(actor);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const lookup = { actorId: who, scope: `script:${input.id}:update`, idempotencyKey: input.idempotencyKey };
    const requestHash = digest(input);
    const old = await getReceipt<{ script: ScriptWorkspace["script"][number]; workspaceVersion: number }>(trx, lookup, requestHash);
    if (old) return { ...old, reused: true };
    const workspace = await getCreativeState(trx, "scriptPlan", input.projectId, input.projectId);
    if (input.workspaceExpectedVersion > workspace.version) throw new ProjectContentError("VERSION_CONFLICT", "工作区版本无效，请重新读取");
    // Keep the caller's episode version as the write precondition. Advancing
    // an aggregate counter for another episode is not an edit to this one.
    const saved = await saveScriptWorkspace(trx, {
      projectId: input.projectId, expectedVersion: workspace.version, mutationKey: input.idempotencyKey, actor,
      script: [{ id: input.id, expectedVersion: input.expectedVersion, name: input.name, content: input.content, ...(input.assets === undefined ? {} : { assets: input.assets }) }],
    });
    const script = saved.script.find((s) => s.id === input.id);
    if (!script) throw new ProjectContentError("NOT_FOUND", "剧本不存在");
    const result = { script, workspaceVersion: saved.version };
    await putReceipt(trx, lookup, requestHash, result);
    return { ...result, reused: false };
  });
}
export async function listScripts(db: Knex, projectId: number, name?: string): Promise<{ scripts: Array<ScriptWorkspace["script"][number] & { extractState: unknown; errorReason: unknown; createTime: unknown; relatedAssets: Array<{ id: number; name: string }> }>; workspaceVersion: number }> {
  const workspace = await readScriptWorkspace(db, projectId), q = name?.trim().toLocaleLowerCase();
  const filtered = q ? workspace.script.filter((s) => s.name.toLocaleLowerCase().includes(q)) : workspace.script;
  const rows = filtered.length ? await db("o_script").where({ projectId }).whereIn("id", filtered.map((s) => s.id)).select("id", "extractState", "errorReason", "createTime") : [];
  const assetIds = [...new Set(filtered.flatMap((script) => script.assets))];
  const assets = assetIds.length ? await db("o_assets").where({ projectId }).whereIn("id", assetIds).select("id", "name") : [];
  return {
    scripts: filtered.map((script) => {
      const row = rows.find((item) => Number(item.id) === script.id);
      return {
        ...script, extractState: row?.extractState ?? null, errorReason: row?.errorReason ?? null, createTime: row?.createTime ?? null,
        relatedAssets: script.assets.map((assetId) => {
          const asset = assets.find((item) => Number(item.id) === assetId);
          return { id: assetId, name: String(asset?.name ?? "") };
        }),
      };
    }),
    workspaceVersion: workspace.version,
  };
}

export async function readNovels(db: Knex, projectId: number, onlyIds?: readonly number[]): Promise<VersionedNovel[]> {
  let query = db("o_novel").where({ projectId }).orderBy("chapterIndex", "asc");
  if (onlyIds) query = query.whereIn("id", onlyIds as number[]);
  const rows = await query;
  const states = rows.length ? await db("ext_creative_state").where({ entityType: "novel", projectId }).whereIn("entityId", rows.map((r) => r.id)) : [];
  return rows.map((row) => ({ ...row, id: Number(row.id), projectId: Number(row.projectId), version: Number(states.find((s) => Number(s.entityId) === Number(row.id))?.version ?? 0) }));
}
export async function createNovels(db: Knex, raw: unknown, actor: TrustedActor): Promise<{ novelIds: number[]; novels: VersionedNovel[]; reused: boolean; processEvents: boolean }> {
  const input = parse(createNovelSchema, mutationInput(raw)), who = actorId(actor), requestHash = digest(input);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const lookup = { actorId: who, scope: "project:" + input.projectId + ":novel:create", idempotencyKey: input.idempotencyKey };
    const old = await getReceipt<{ novelIds: number[]; novels: VersionedNovel[]; processEvents: boolean }>(trx, lookup, requestHash);
    if (old) return { ...old, reused: true };
    if (!(await trx("o_project").where({ id: input.projectId }).first())) throw new ProjectContentError("NOT_FOUND", "项目不存在");
    const max = await trx("o_novel").where({ projectId: input.projectId }).max("chapterIndex as value").first();
    let chapterIndex = Number(max?.value ?? 0); const novelIds: number[] = [];
    for (const item of input.data) {
      const [novelId] = await insertRowsReturningIds(trx, "o_novel", { projectId: input.projectId, chapterIndex: ++chapterIndex, reel: item.reel, chapter: item.chapter, chapterData: item.chapterData, createTime: Date.now(), eventState: input.processEvents ? 0 : null });
      novelIds.push(novelId);
      await advanceCreativeState(trx, { entityType: "novel", entityId: novelId, projectId: input.projectId, expectedVersion: 0, actor });
    }
    const result = { novelIds, novels: await readNovels(trx, input.projectId, novelIds), processEvents: input.processEvents };
    await putReceipt(trx, lookup, requestHash, result);
    return { ...result, reused: false };
  });
}
export async function updateNovel(db: Knex, raw: unknown, actor: TrustedActor): Promise<{ novel: VersionedNovel; reused: boolean }> {
  const input = parse(updateNovelSchema, mutationInput(raw)), who = actorId(actor), requestHash = digest(input);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const lookup = { actorId: who, scope: "project:" + input.projectId + ":novel:" + input.id + ":update", idempotencyKey: input.idempotencyKey };
    const old = await getReceipt<{ novel: VersionedNovel }>(trx, lookup, requestHash);
    if (old) return { ...old, reused: true };
    if (!(await trx("o_novel").where({ id: input.id, projectId: input.projectId }).first())) throw new ProjectContentError("PROJECT_MISMATCH", "原文不属于当前项目");
    await advanceCreativeState(trx, { entityType: "novel", entityId: input.id, projectId: input.projectId, expectedVersion: input.expectedVersion, actor });
    await trx("o_novel").where({ id: input.id, projectId: input.projectId }).update({ chapterIndex: Number(input.index), reel: input.reel, chapter: input.chapter, chapterData: input.chapterData, ...(input.event === undefined ? {} : { event: input.event }) });
    const result = { novel: (await readNovels(trx, input.projectId, [input.id]))[0] };
    await putReceipt(trx, lookup, requestHash, result);
    return { ...result, reused: false };
  });
}
export async function applyNovelEventResult(db: Knex, input: { id: number; projectId: number; expectedVersion: number; event?: string; errorReason?: string; actor: TrustedActor }): Promise<VersionedNovel> {
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    if (!(await trx("o_novel").where({ id: input.id, projectId: input.projectId }).first())) throw new ProjectContentError("PROJECT_MISMATCH", "原文不属于当前项目");
    await advanceCreativeState(trx, { entityType: "novel", entityId: input.id, projectId: input.projectId, expectedVersion: input.expectedVersion, actor: input.actor });
    await trx("o_novel").where({ id: input.id, projectId: input.projectId }).update({ event: input.event ?? null, eventState: input.event ? 1 : -1, errorReason: input.errorReason ?? null });
    return (await readNovels(trx, input.projectId, [input.id]))[0];
  });
}

const ACTIVE_BUILTIN = ["queued", "running", "waiting_human", "paused"];
const TERMINAL_IMAGE = ["SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED"];
const TERMINAL_VIDEO = ["SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED"];

async function hasTable(db: Knex | Knex.Transaction, name: string): Promise<boolean> {
  return db.schema.hasTable(name);
}

async function assertNoActiveProjectWork(trx: Knex.Transaction, projectId: number): Promise<void> {
  if (await hasTable(trx, "ext_builtin_runs")) {
    const run = await trx("ext_builtin_runs").where({ projectId }).whereIn("status", ACTIVE_BUILTIN).first("id");
    if (run) throw new ProjectContentError("ACTIVE_TASK", "项目仍有活动中的内置 Agent 运行，不能删除内容");
  }
  if (await hasTable(trx, "ext_image_jobs")) {
    const job = await trx("ext_image_jobs").where({ projectId }).whereNotIn("status", TERMINAL_IMAGE).first("id");
    if (job) throw new ProjectContentError("ACTIVE_TASK", "项目仍有活动中的图片任务，不能删除内容");
  }
  if (await hasTable(trx, "ext_video_jobs")) {
    const job = await trx("ext_video_jobs").where({ projectId }).whereNotIn("status", TERMINAL_VIDEO).first("id");
    if (job) throw new ProjectContentError("ACTIVE_TASK", "项目仍有活动中的视频任务，不能删除内容");
  }
}

async function assertNoLockedStoryboards(trx: Knex.Transaction, projectId: number, scriptIds?: readonly number[]): Promise<void> {
  if (!(await hasTable(trx, "ext_entity_state")) || !(await hasTable(trx, "o_storyboard"))) return;
  let query = trx("o_storyboard as storyboard")
    .join("ext_entity_state as state", function joinState() {
      this.on("state.entityType", "=", trx.raw("?", ["storyboard"]))
        .andOn("state.entityId", "=", "storyboard.id")
        .andOn("state.locked", "=", trx.raw("?", [1]));
    })
    .where("storyboard.projectId", projectId);
  if (scriptIds) query = query.whereIn("storyboard.scriptId", scriptIds as number[]);
  if (await query.first("storyboard.id")) throw new ProjectContentError("LOCKED", "锁定分镜引用了待删除内容");
}

async function deleteWhereIn(trx: Knex.Transaction, table: string, column: string, values: readonly (number | string)[]): Promise<void> {
  if (values.length && await hasTable(trx, table)) await trx(table).whereIn(column, values as Array<number | string>).delete();
}

async function deleteProjectRelations(trx: Knex.Transaction, projectId: number): Promise<void> {
  const scripts = await trx("o_script").where({ projectId }).select("id");
  const scriptIds = scripts.map((row) => Number(row.id));
  const novels = await trx("o_novel").where({ projectId }).select("id");
  const novelIds = novels.map((row) => Number(row.id));
  const storyboards = await trx("o_storyboard").where({ projectId }).select("id");
  const storyboardIds = storyboards.map((row) => Number(row.id));
  const assets = await trx("o_assets").where({ projectId }).select("id", "imageId");
  const assetIds = assets.map((row) => Number(row.id));
  const selectedImageIds = assets.map((row) => Number(row.imageId)).filter((value) => Number.isSafeInteger(value) && value > 0);

  let eventIds: number[] = [];
  if (novelIds.length) {
    const links = await trx("o_eventChapter").whereIn("novelId", novelIds).select("eventId");
    eventIds = links.map((row) => Number(row.eventId)).filter((value) => Number.isSafeInteger(value) && value > 0);
    await trx("o_eventChapter").whereIn("novelId", novelIds).delete();
    if (eventIds.length) await trx("o_event").whereIn("id", eventIds).whereNotIn("id", trx("o_eventChapter").select("eventId")).delete();
  }

  await deleteWhereIn(trx, "o_assets2Storyboard", "storyboardId", storyboardIds);
  await deleteWhereIn(trx, "o_scriptAssets", "scriptId", scriptIds);
  if (assetIds.length && await hasTable(trx, "o_assetsRole2Audio")) {
    await trx("o_assetsRole2Audio").whereIn("assetsRoleId", assetIds).orWhereIn("assetsAudioId", assetIds).delete();
  }
  if (await hasTable(trx, "ext_image_job_bindings")) await trx("ext_image_job_bindings").where({ projectId }).delete();
  if (await hasTable(trx, "ext_image_jobs")) await trx("ext_image_jobs").where({ projectId }).delete();
  if (await hasTable(trx, "ext_video_jobs")) await trx("ext_video_jobs").where({ projectId }).delete();
  if (await hasTable(trx, "ext_builtin_runs")) {
    const runs = await trx("ext_builtin_runs").where({ projectId }).select("id");
    const runIds = runs.map((row) => String(row.id));
    await deleteWhereIn(trx, "ext_builtin_run_events", "runId", runIds);
    await deleteWhereIn(trx, "ext_builtin_run_steps", "runId", runIds);
    await trx("ext_builtin_runs").where({ projectId }).delete();
  }

  await trx("o_assets").where({ projectId }).update({ imageId: null });
  if (assetIds.length || selectedImageIds.length) {
    await trx("o_image").whereIn("assetsId", assetIds.length ? assetIds : [-1]).orWhereIn("id", selectedImageIds.length ? selectedImageIds : [-1]).delete();
  }
  await trx("o_video").where({ projectId }).delete();
  await trx("o_videoTrack").where({ projectId }).delete();
  await trx("o_storyboard").where({ projectId }).delete();
  await trx("o_tasks").where({ projectId }).delete();
  await trx("o_agentWorkData").where({ projectId }).delete();
  await trx("o_script").where({ projectId }).delete();
  await trx("o_novel").where({ projectId }).delete();
  await trx("o_assets").where({ projectId }).delete();
  await trx("memories").where("isolationKey", "like", `${projectId}:%`).delete();

  for (const table of ["ext_asset_extraction_receipts", "ext_asset_mutations", "ext_track_mutations", "ext_creative_mutations", "ext_media_job_recoveries"]) {
    if (await hasTable(trx, table)) await trx(table).where({ projectId }).delete();
  }
  if (await hasTable(trx, "ext_agent_mutations")) await trx("ext_agent_mutations").where({ projectId }).delete();
  if (await hasTable(trx, "ext_entity_state")) await trx("ext_entity_state").where({ projectId }).delete();
  if (await hasTable(trx, "ext_creative_state")) await trx("ext_creative_state").where({ projectId }).delete();
  if (await hasTable(trx, "team_projects")) await trx("team_projects").where({ project_id: projectId }).delete();
  await trx(MUTATIONS).where("scope", "like", `project:${projectId}:%`).delete();
  await trx("o_project").where({ id: projectId }).delete();
}

export async function deleteProject(db: Knex, raw: unknown, actor: TrustedActor): Promise<{ projectId: number; deleted: true; reused: boolean }> {
  const input = parse(deleteProjectSchema, mutationInput(raw)), who = actorId(actor), requestHash = digest(input);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.id);
    const lookup = { actorId: who, scope: `project:${input.id}:delete`, idempotencyKey: input.idempotencyKey };
    const old = await getReceipt<{ projectId: number; deleted: true }>(trx, lookup, requestHash);
    if (old) return { ...old, reused: true };
    if (!(await trx("o_project").where({ id: input.id }).first())) throw new ProjectContentError("NOT_FOUND", "项目不存在");
    const state = await getCreativeState(trx, "project", input.id, input.id);
    if (state.version !== input.expectedVersion) throw new ProjectContentError("VERSION_CONFLICT", "项目已被其他成员或任务修改，请读取最新版本");
    await assertNoActiveProjectWork(trx, input.id);
    await assertNoLockedStoryboards(trx, input.id);
    await deleteProjectRelations(trx, input.id);
    const result = { projectId: input.id, deleted: true as const };
    await putReceipt(trx, lookup, requestHash, result);
    return { ...result, reused: false };
  });
}

export async function deleteNovels(db: Knex, raw: unknown, actor: TrustedActor): Promise<{ novelIds: number[]; deleted: true; reused: boolean }> {
  const input = parse(deleteNovelsSchema, mutationInput(raw)), who = actorId(actor);
  const items = [...input.items].sort((left, right) => left.id - right.id);
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new ProjectContentError("INVALID_INPUT", "同一原文不能重复删除");
  const normalized = { ...input, items };
  const requestHash = digest(normalized);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const lookup = { actorId: who, scope: `project:${input.projectId}:novel:delete`, idempotencyKey: input.idempotencyKey };
    const old = await getReceipt<{ novelIds: number[]; deleted: true }>(trx, lookup, requestHash);
    if (old) return { ...old, reused: true };
    const rows = await trx("o_novel").where({ projectId: input.projectId }).whereIn("id", items.map((item) => item.id)).select("id");
    if (rows.length !== items.length) throw new ProjectContentError("PROJECT_MISMATCH", "原文不属于当前项目");
    for (const item of items) {
      const state = await getCreativeState(trx, "novel", item.id, input.projectId);
      if (state.version !== item.expectedVersion) throw new ProjectContentError("VERSION_CONFLICT", "原文已被修改，请读取最新版本");
    }
    await assertNoActiveProjectWork(trx, input.projectId);
    const novelIds = items.map((item) => item.id);
    const links = await trx("o_eventChapter").whereIn("novelId", novelIds).select("eventId");
    const eventIds = links.map((item) => Number(item.eventId)).filter((value) => Number.isSafeInteger(value) && value > 0);
    await trx("o_eventChapter").whereIn("novelId", novelIds).delete();
    if (eventIds.length) await trx("o_event").whereIn("id", eventIds).whereNotIn("id", trx("o_eventChapter").select("eventId")).delete();
    await trx("o_novel").where({ projectId: input.projectId }).whereIn("id", novelIds).delete();
    await trx("ext_creative_state").where({ entityType: "novel", projectId: input.projectId }).whereIn("entityId", novelIds).delete();
    for (const novelId of novelIds) await trx(MUTATIONS).where("scope", "like", `project:${input.projectId}:novel:${novelId}:%`).delete();
    const result = { novelIds, deleted: true as const };
    await putReceipt(trx, lookup, requestHash, result);
    return { ...result, reused: false };
  });
}

export async function deleteNovel(db: Knex, raw: unknown, actor: TrustedActor): Promise<{ novelId: number; deleted: true; reused: boolean }> {
  const input = parse(deleteNovelSchema, mutationInput(raw));
  const result = await deleteNovels(db, { projectId: input.projectId, items: [{ id: input.id, expectedVersion: input.expectedVersion }], idempotencyKey: input.idempotencyKey }, actor);
  return { novelId: result.novelIds[0], deleted: true, reused: result.reused };
}

export async function deleteScripts(db: Knex, raw: unknown, actor: TrustedActor): Promise<{ scriptIds: number[]; workspaceVersion: number; deleted: true; reused: boolean }> {
  const input = parse(deleteScriptsSchema, mutationInput(raw)), who = actorId(actor);
  const ids = [...new Set(input.ids)].sort((left, right) => left - right);
  if (ids.length !== input.ids.length || input.versions.length !== ids.length || new Set(input.versions.map((item) => item.id)).size !== ids.length || input.versions.some((item) => !ids.includes(item.id))) {
    throw new ProjectContentError("INVALID_INPUT", "每个待删除剧本必须且只能提供一个最新版本");
  }
  const normalized = { ...input, ids, versions: [...input.versions].sort((left, right) => left.id - right.id) };
  const requestHash = digest(normalized);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const lookup = { actorId: who, scope: `project:${input.projectId}:script:delete`, idempotencyKey: input.idempotencyKey };
    const old = await getReceipt<{ scriptIds: number[]; workspaceVersion: number; deleted: true }>(trx, lookup, requestHash);
    if (old) return { ...old, reused: true };
    const workspace = await readScriptWorkspace(trx, input.projectId);
    if (workspace.version !== input.workspaceExpectedVersion) throw new ProjectContentError("VERSION_CONFLICT", "剧本工作区已变化，请读取最新版本");
    for (const item of normalized.versions) {
      const current = workspace.script.find((script) => script.id === item.id);
      if (!current) throw new ProjectContentError("PROJECT_MISMATCH", "剧本不属于当前项目");
      if (current.version !== item.expectedVersion) throw new ProjectContentError("VERSION_CONFLICT", "剧本已被修改，请读取最新版本");
    }
    await assertNoActiveProjectWork(trx, input.projectId);
    await assertNoLockedStoryboards(trx, input.projectId, ids);
    const storyboards = await trx("o_storyboard").where({ projectId: input.projectId }).whereIn("scriptId", ids).select("id");
    const storyboardIds = storyboards.map((row) => Number(row.id));
    if (await hasTable(trx, "ext_image_job_bindings")) {
      const bindings = await trx("ext_image_job_bindings").where({ projectId: input.projectId }).whereIn("scriptId", ids).select("jobId");
      const jobIds = bindings.map((row) => Number(row.jobId));
      await trx("ext_image_job_bindings").where({ projectId: input.projectId }).whereIn("scriptId", ids).delete();
      await deleteWhereIn(trx, "ext_image_jobs", "id", jobIds);
    }
    if (await hasTable(trx, "ext_video_jobs")) await trx("ext_video_jobs").where({ projectId: input.projectId }).whereIn("scriptId", ids).delete();
    if (await hasTable(trx, "ext_builtin_runs")) {
      const runs = await trx("ext_builtin_runs").where({ projectId: input.projectId }).whereIn("scriptId", ids).select("id");
      const runIds = runs.map((row) => String(row.id));
      await deleteWhereIn(trx, "ext_builtin_run_events", "runId", runIds);
      await deleteWhereIn(trx, "ext_builtin_run_steps", "runId", runIds);
      await trx("ext_builtin_runs").where({ projectId: input.projectId }).whereIn("scriptId", ids).delete();
    }
    await deleteWhereIn(trx, "o_assets2Storyboard", "storyboardId", storyboardIds);
    await trx("o_agentWorkData").where({ projectId: input.projectId }).whereIn("episodesId", ids).delete();
    await trx("o_scriptAssets").whereIn("scriptId", ids).delete();
    await trx("o_video").where({ projectId: input.projectId }).whereIn("scriptId", ids).delete();
    await trx("o_videoTrack").where({ projectId: input.projectId }).whereIn("scriptId", ids).delete();
    await trx("o_storyboard").where({ projectId: input.projectId }).whereIn("scriptId", ids).delete();
    await trx("o_script").where({ projectId: input.projectId }).whereIn("id", ids).delete();
    if (await hasTable(trx, "ext_entity_state") && storyboardIds.length) await trx("ext_entity_state").where({ entityType: "storyboard", projectId: input.projectId }).whereIn("entityId", storyboardIds).delete();
    await trx("ext_creative_state").where({ projectId: input.projectId, entityType: "script" }).whereIn("entityId", ids).delete();
    if (await hasTable(trx, "ext_creative_mutations")) await trx("ext_creative_mutations").where({ projectId: input.projectId }).delete();
    if (await hasTable(trx, "ext_asset_extraction_receipts")) await trx("ext_asset_extraction_receipts").where({ projectId: input.projectId }).delete();
    const nextState = await advanceCreativeState(trx, { entityType: "scriptPlan", entityId: input.projectId, projectId: input.projectId, expectedVersion: input.workspaceExpectedVersion, actor });
    const result = { scriptIds: ids, workspaceVersion: nextState.version, deleted: true as const };
    await putReceipt(trx, lookup, requestHash, result);
    return { ...result, reused: false };
  });
}
export async function readNovelIndex(db: Knex, projectId: number): Promise<Array<{ id: number; index: number; chapter: string; version: number }>> {
  return (await readNovels(db, projectId)).map((n) => ({ id: n.id, index: Number(n.chapterIndex), chapter: String(n.chapter ?? ""), version: n.version }));
}
export function asProjectContentError(error: unknown): ProjectContentError {
  if (error instanceof ProjectContentError) return error;
  if (error instanceof CreativeWorkspaceError) return new ProjectContentError(error.code, error.message);
  return new ProjectContentError("INVALID_INPUT", error instanceof Error ? error.message : "内容操作失败");
}

export type { ProjectConfigurationMetadata, ProjectModelMetadata } from "./configuration";
export { listConfigurationDirectories, loadEnabledProjectModels, projectConfigurationIssue, PROJECT_IMAGE_QUALITIES, PROJECT_VIDEO_RATIOS } from "./configuration";
