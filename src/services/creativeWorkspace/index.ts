import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { isPostgres, lockProjectTransaction } from "../../lib/dbTransaction";
import { insertRowsReturningIds } from "../../lib/insertRows";
import type { TrustedActor } from "../productionState";

export class CreativeWorkspaceError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "INVALID_INPUT" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "PROJECT_MISMATCH", message: string) {
    super(message);
    this.name = "CreativeWorkspaceError";
  }
}

export type CreativeEntityType = "scriptPlan" | "script" | "project" | "novel" | "event" | "asset" | "track" | "imageFlow";
export interface CreativeState {
  entityType: CreativeEntityType;
  entityId: number;
  projectId: number;
  version: number;
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface ScriptWorkspace {
  id: number | null;
  projectId: number;
  version: number;
  storySkeleton: string;
  adaptationStrategy: string;
  script: Array<{ id: number; name: string; content: string; version: number; assets: number[] }>;
}

const positiveId = z.number().int().positive();
const version = z.number().int().nonnegative();
const mutationKey = z.string().min(8).max(150).regex(/^[\w:.-]+$/);
const scriptInput = z.object({
  id: positiveId.optional(),
  expectedVersion: version.optional(),
  name: z.string().trim().min(1).max(500),
  content: z.string().max(2_000_000),
  assets: z.array(positiveId).max(10000).optional(),
}).strict();
export const saveScriptWorkspaceSchema = z.object({
  projectId: positiveId,
  expectedVersion: version,
  mutationKey,
  storySkeleton: z.string().max(2_000_000).optional(),
  adaptationStrategy: z.string().max(2_000_000).optional(),
  script: z.array(scriptInput).max(200).optional(),
}).strict();
export type SaveScriptWorkspaceInput = z.infer<typeof saveScriptWorkspaceSchema> & { actor: TrustedActor };

async function inProject<T>(db: Knex, projectId: number, operation: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  if ((db as Knex.Transaction).isTransaction) {
    const trx = db as Knex.Transaction;
    await lockProjectTransaction(trx, projectId);
    return operation(trx);
  }
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    return operation(trx);
  });
}

export async function ensureCreativeWorkspaceSchema(db: Knex): Promise<void> {
  await db.transaction(async (trx) => {
    if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["toonflow:creative-workspace-schema"]);
    if (!(await trx.schema.hasTable("ext_creative_state"))) {
      await trx.schema.createTable("ext_creative_state", (table) => {
        table.text("entityType").notNullable();
        table.bigInteger("entityId").notNullable();
        table.bigInteger("projectId").notNullable();
        table.bigInteger("version").notNullable().defaultTo(0);
        table.text("updatedBy");
        table.bigInteger("updatedAt");
        table.primary(["entityType", "entityId"]);
        table.index(["projectId", "entityType"]);
      });
    }
    if (!(await trx.schema.hasTable("ext_creative_mutations"))) {
      await trx.schema.createTable("ext_creative_mutations", (table) => {
        table.text("actorId").notNullable();
        table.bigInteger("projectId").notNullable();
        table.text("mutationKey").notNullable();
        table.text("requestHash").notNullable();
        table.text("result").notNullable();
        table.bigInteger("createdAt").notNullable();
        table.primary(["actorId", "projectId", "mutationKey"]);
      });
    }
  });
}

export async function getCreativeState(db: Knex, entityType: CreativeEntityType, entityId: number, projectId: number): Promise<CreativeState> {
  const row = await db("ext_creative_state").where({ entityType, entityId }).first();
  if (row && Number(row.projectId) !== projectId) throw new CreativeWorkspaceError("PROJECT_MISMATCH", "资源不属于当前项目");
  return {
    entityType, entityId, projectId, version: Number(row?.version ?? 0),
    updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt == null ? null : Number(row.updatedAt),
  };
}

/** Caller must hold the project transaction lock and validate the actual entity. */
export async function advanceCreativeState(trx: Knex.Transaction, input: {
  entityType: CreativeEntityType; entityId: number; projectId: number; expectedVersion: number; actor: TrustedActor;
}): Promise<CreativeState> {
  const { entityType, entityId, projectId, expectedVersion, actor } = input;
  const current = await getCreativeState(trx, entityType, entityId, projectId);
  if (current.version !== expectedVersion) throw new CreativeWorkspaceError("VERSION_CONFLICT", "内容已被其他成员或任务修改，请读取最新版本");
  const next = { entityType, entityId, projectId, version: expectedVersion + 1, updatedBy: actor.id, updatedAt: Date.now() };
  await trx("ext_creative_state").insert(next).onConflict(["entityType", "entityId"]).merge(next);
  return next;
}

function validateActor(actor: TrustedActor): void {
  if (!actor || !["human", "agent", "system"].includes(actor.kind) || typeof actor.id !== "string" || !actor.id.trim() || actor.id.length > 250) {
    throw new CreativeWorkspaceError("INVALID_INPUT", "缺少可信操作身份");
  }
}

function parseDocument(raw: unknown): { storySkeleton: string; adaptationStrategy: string } {
  let data: any = {};
  try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { /* The relational scripts remain readable. */ }
  return {
    storySkeleton: typeof data?.storySkeleton === "string" ? data.storySkeleton : "",
    adaptationStrategy: typeof data?.adaptationStrategy === "string" ? data.adaptationStrategy : "",
  };
}

async function assertProject(db: Knex, projectId: number): Promise<void> {
  if (!(await db("o_project").where({ id: projectId }).first())) throw new CreativeWorkspaceError("NOT_FOUND", "项目不存在");
}

export async function readScriptWorkspace(db: Knex, projectId: number): Promise<ScriptWorkspace> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new CreativeWorkspaceError("INVALID_INPUT", "项目编号无效");
  return inProject(db, projectId, async (trx) => {
    await assertProject(trx, projectId);
    const row = await trx("o_agentWorkData").where({ projectId, key: "scriptAgent" }).whereNull("episodesId").orderBy("id").first();
    const state = await getCreativeState(trx, "scriptPlan", projectId, projectId);
    const scripts = await trx("o_script").where({ projectId }).orderBy("id").select("id", "name", "content");
    const links = scripts.length ? await trx("o_scriptAssets").whereIn("scriptId", scripts.map((s) => s.id)).orderBy("assetId") : [];
    const states = scripts.length ? await trx("ext_creative_state").where({ projectId, entityType: "script" }).whereIn("entityId", scripts.map((s) => s.id)) : [];
    return {
      id: row ? Number(row.id) : null, projectId, version: state.version, ...parseDocument(row?.data),
      script: scripts.map((s) => ({
        id: Number(s.id), name: s.name ?? "", content: s.content ?? "",
        version: Number(states.find((v) => Number(v.entityId) === Number(s.id))?.version ?? 0),
        assets: links.filter((l) => Number(l.scriptId) === Number(s.id)).map((l) => Number(l.assetId)),
      })),
    };
  });
}

export async function saveScriptWorkspace(db: Knex, raw: SaveScriptWorkspaceInput): Promise<ScriptWorkspace & { createdScriptIds: number[]; replayed: boolean }> {
  const { actor, ...body } = raw;
  validateActor(actor);
  const parsed = saveScriptWorkspaceSchema.safeParse(body);
  if (!parsed.success) throw new CreativeWorkspaceError("INVALID_INPUT", parsed.error.issues.map((i) => i.message).join("; "));
  const data = parsed.data;
  const editedIds = data.script?.filter((s) => s.id != null).map((s) => s.id!) ?? [];
  if (new Set(editedIds).size !== editedIds.length) throw new CreativeWorkspaceError("INVALID_INPUT", "同一请求不能重复修改同一个剧本");
  if (data.script?.some((s) => s.id != null && s.expectedVersion == null)) throw new CreativeWorkspaceError("INVALID_INPUT", "修改已有剧本需要读取版本");
  const requestHash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  return inProject(db, data.projectId, async (trx) => {
    await assertProject(trx, data.projectId);
    const key = { actorId: actor.id, projectId: data.projectId, mutationKey: data.mutationKey };
    const previous = await trx("ext_creative_mutations").where(key).first();
    if (previous) {
      if (previous.requestHash !== requestHash) throw new CreativeWorkspaceError("IDEMPOTENCY_CONFLICT", "该操作编号已用于不同内容");
      return { ...JSON.parse(previous.result), replayed: true };
    }
    // Check all references before changing anything; the same transaction also owns the final version update.
    const before = await readScriptWorkspace(trx, data.projectId);
    if (before.version !== data.expectedVersion) throw new CreativeWorkspaceError("VERSION_CONFLICT", "剧本工作区已变化，请读取最新版本");
    for (const s of data.script ?? []) {
      if (s.id != null) {
        const current = before.script.find((row) => row.id === s.id);
        if (!current) throw new CreativeWorkspaceError("PROJECT_MISMATCH", "剧本不属于当前项目");
        if (current.version !== s.expectedVersion) throw new CreativeWorkspaceError("VERSION_CONFLICT", "剧本已被修改，请读取最新版本");
      }
      if (s.assets != null) {
        const assetIds = [...new Set(s.assets)];
        const assets = assetIds.length ? await trx("o_assets").where({ projectId: data.projectId }).whereIn("id", assetIds).select("id") : [];
        if (assets.length !== assetIds.length) throw new CreativeWorkspaceError("PROJECT_MISMATCH", "引用素材不属于当前项目");
      }
    }
    const createdScriptIds: number[] = [];
    for (const s of data.script ?? []) {
      let id = s.id;
      if (id == null) {
        [id] = await insertRowsReturningIds(trx, "o_script", { projectId: data.projectId, name: s.name, content: s.content, createTime: Date.now() });
        createdScriptIds.push(id);
      } else {
        await trx("o_script").where({ id, projectId: data.projectId }).update({ name: s.name, content: s.content });
      }
      if (s.assets != null) {
        await trx("o_scriptAssets").where({ scriptId: id }).delete();
        const ids = [...new Set(s.assets)];
        if (ids.length) await trx("o_scriptAssets").insert(ids.map((assetId) => ({ scriptId: id, assetId })));
      }
      await advanceCreativeState(trx, { entityType: "script", entityId: id, projectId: data.projectId, expectedVersion: s.expectedVersion ?? 0, actor });
    }
    const document = JSON.stringify({
      storySkeleton: data.storySkeleton ?? before.storySkeleton,
      adaptationStrategy: data.adaptationStrategy ?? before.adaptationStrategy,
    });
    if (before.id != null) await trx("o_agentWorkData").where({ id: before.id, projectId: data.projectId }).update({ data: document });
    else await trx("o_agentWorkData").insert({ projectId: data.projectId, key: "scriptAgent", episodesId: null, data: document });
    await advanceCreativeState(trx, { entityType: "scriptPlan", entityId: data.projectId, projectId: data.projectId, expectedVersion: data.expectedVersion, actor });
    const result = { ...await readScriptWorkspace(trx, data.projectId), createdScriptIds, replayed: false };
    await trx("ext_creative_mutations").insert({ ...key, requestHash, result: JSON.stringify(result), createdAt: Date.now() });
    return result;
  });
}
