import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { isPostgres, lockProjectTransaction } from "../../lib/dbTransaction";
import { insertRowsReturningIds } from "../../lib/insertRows";
import {
  advanceCreativeState,
  ensureCreativeWorkspaceSchema,
  getCreativeState,
} from "../creativeWorkspace";
import { ensureProductionStateSchema } from "../productionState";
import type { TrustedActor } from "../productionState";

const RECEIPTS = "ext_asset_extraction_receipts";
const ROOT_TYPES = ["role", "scene", "tool"] as const;

export type RootAssetType = (typeof ROOT_TYPES)[number];
export type AssetSemanticGroup = "roles" | "scenes" | "props";

export class AssetExtractionWorkspaceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "PROJECT_MISMATCH"
      | "TYPE_MISMATCH"
      | "VERSION_CONFLICT"
      | "IDEMPOTENCY_CONFLICT"
      | "LOCKED",
    message: string,
  ) {
    super(message);
    this.name = "AssetExtractionWorkspaceError";
  }
}

const positiveId = z.number().int().positive();
const version = z.number().int().nonnegative();
const key = z.string().trim().min(1).max(120).regex(/^[\w:.-]+$/);
const mutationKey = z.string().min(8).max(150).regex(/^[\w:.-]+$/);
const name = z.string().trim().min(1).max(500);
const text = z.string().max(20_000);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export function scriptContentHash(content: unknown): string {
  return createHash("sha256").update(String(content ?? "")).digest("hex");
}

export const createAssetDecisionSchema = z.object({
  action: z.literal("create"),
  key,
  name,
  description: text,
  prompt: text,
}).strict();

export const reuseAssetDecisionSchema = z.object({
  action: z.literal("reuse"),
  assetId: positiveId,
  expectedVersion: version,
}).strict();

export const updateAssetDecisionSchema = z.object({
  action: z.literal("update"),
  assetId: positiveId,
  expectedVersion: version,
  name: name.optional(),
  description: text.optional(),
  prompt: text.optional(),
}).strict().refine((value) => value.name !== undefined || value.description !== undefined || value.prompt !== undefined, {
  message: "更新已有素材时至少提供一个字段",
});

export const assetDecisionSchema = z.union([
  createAssetDecisionSchema,
  reuseAssetDecisionSchema,
  updateAssetDecisionSchema,
]);

export const assetBindingRefSchema = z.union([
  z.object({ kind: z.literal("existing"), assetId: positiveId }).strict(),
  z.object({ kind: z.literal("created"), key }).strict(),
]);

export const assetExtractionProposalSchema = z.object({
  roles: z.array(assetDecisionSchema).max(500),
  scenes: z.array(assetDecisionSchema).max(500),
  props: z.array(assetDecisionSchema).max(500),
  // Omitted bindings preserve every episode's current links. A present episode
  // with an empty assets array explicitly clears that episode's links.
  bindings: z.array(z.object({
    scriptId: positiveId,
    assets: z.array(assetBindingRefSchema).max(1500),
  }).strict()).max(100).optional(),
  summary: z.string().max(4000),
}).strict();

export type AssetExtractionProposal = z.infer<typeof assetExtractionProposalSchema>;

export const applyAssetExtractionSchema = z.object({
  projectId: positiveId,
  expectedWorkspaceVersion: version,
  sourceScripts: z.array(z.object({ id: positiveId, expectedVersion: version, contentHash: sha256 }).strict()).min(1).max(100),
  proposal: assetExtractionProposalSchema,
  idempotencyKey: mutationKey,
}).strict();

export type ApplyAssetExtractionInput = z.infer<typeof applyAssetExtractionSchema> & { actor: TrustedActor };

export interface AssetExtractionSnapshot {
  project: { id: number; name: string; artStyle: string; type: string };
  workspaceVersion: number;
  scripts: Array<{ id: number; name: string; content: string; contentHash: string; version: number }>;
  assets: Array<{
    id: number;
    name: string;
    type: RootAssetType;
    description: string;
    prompt: string;
    version: number;
    locked: boolean;
  }>;
}

export interface AssetExtractionReceipt {
  projectId: number;
  assetIds: number[];
  createdAssetIds: number[];
  updatedAssetIds: number[];
  bindings: Array<{ scriptId: number; assetIds: number[]; version: number }>;
  workspaceVersion: number;
  reused: boolean;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((item) => `${JSON.stringify(item)}:${canonical(record[item])}`).join(",")}}`;
}

const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

function validateActor(actor: TrustedActor): void {
  if (!actor || !["human", "agent", "system"].includes(actor.kind) || typeof actor.id !== "string" || !actor.id.trim() || actor.id.length > 250) {
    throw new AssetExtractionWorkspaceError("INVALID_INPUT", "缺少可信操作身份");
  }
}

function asType(group: AssetSemanticGroup): RootAssetType {
  if (group === "roles") return "role";
  if (group === "scenes") return "scene";
  return "tool";
}

function decisions(proposal: AssetExtractionProposal): Array<{ group: AssetSemanticGroup; type: RootAssetType; decision: z.infer<typeof assetDecisionSchema> }> {
  return (["roles", "scenes", "props"] as const).flatMap((group) => proposal[group].map((decision) => ({ group, type: asType(group), decision })));
}

async function assertProject(db: Knex | Knex.Transaction, projectId: number): Promise<any> {
  const project = await db("o_project").where({ id: projectId }).first();
  if (!project) throw new AssetExtractionWorkspaceError("NOT_FOUND", "项目不存在");
  return project;
}

async function assertScriptVersion(
  db: Knex | Knex.Transaction,
  projectId: number,
  source: { id: number; expectedVersion: number; contentHash?: string },
): Promise<any> {
  const script = await db("o_script").where({ id: source.id, projectId }).first();
  if (!script) {
    const exists = await db("o_script").where({ id: source.id }).first();
    throw new AssetExtractionWorkspaceError(exists ? "PROJECT_MISMATCH" : "NOT_FOUND", "剧集不存在或不属于指定项目");
  }
  const state = await getCreativeState(db as Knex, "script", source.id, projectId);
  if (state.version !== source.expectedVersion) throw new AssetExtractionWorkspaceError("VERSION_CONFLICT", `剧集 ${source.id} 已被修改`);
  if (source.contentHash !== undefined && scriptContentHash(script.content) !== source.contentHash) {
    throw new AssetExtractionWorkspaceError("VERSION_CONFLICT", `剧集 ${source.id} 正文已被修改`);
  }
  return script;
}

async function lockedAssetIds(db: Knex | Knex.Transaction, assetIds: number[]): Promise<Set<number>> {
  if (!assetIds.length) return new Set();
  const rows = await db("o_assets2Storyboard as link")
    .join("ext_entity_state as state", function joinState() {
      this.on("state.entityType", "=", db.raw("?", ["storyboard"]))
        .andOn("state.entityId", "=", "link.storyboardId")
        .andOn("state.locked", "=", db.raw("?", [1]));
    })
    .whereIn("link.assetId", assetIds)
    .select("link.assetId");
  return new Set(rows.map((row: any) => Number(row.assetId)));
}

export async function ensureAssetExtractionWorkspaceSchema(db: Knex): Promise<void> {
  await ensureCreativeWorkspaceSchema(db);
  await ensureProductionStateSchema(db);
  await db.transaction(async (trx) => {
    if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["toonflow:asset-extraction-schema"]);
    if (!(await trx.schema.hasTable(RECEIPTS))) {
      await trx.schema.createTable(RECEIPTS, (table) => {
        table.text("actorId").notNullable();
        table.bigInteger("projectId").notNullable();
        table.text("idempotencyKey").notNullable();
        table.text("requestHash").notNullable();
        table.jsonb("result").notNullable();
        table.bigInteger("createdAt").notNullable();
        table.primary(["actorId", "projectId", "idempotencyKey"]);
      });
    }
  });
}

export async function readAssetExtractionSnapshot(
  db: Knex,
  input: { projectId: number; sourceScripts: Array<{ id: number; expectedVersion: number }> },
): Promise<AssetExtractionSnapshot> {
  const parsed = z.object({
    projectId: positiveId,
    sourceScripts: z.array(z.object({ id: positiveId, expectedVersion: version }).strict()).min(1).max(100),
  }).strict().safeParse(input);
  if (!parsed.success) throw new AssetExtractionWorkspaceError("INVALID_INPUT", parsed.error.issues.map((issue) => issue.message).join("; "));
  if (new Set(parsed.data.sourceScripts.map((source) => source.id)).size !== parsed.data.sourceScripts.length) {
    throw new AssetExtractionWorkspaceError("INVALID_INPUT", "同一剧集不能重复提取");
  }
  const project = await assertProject(db, parsed.data.projectId);
  const scripts = [] as AssetExtractionSnapshot["scripts"];
  for (const source of parsed.data.sourceScripts) {
    const row = await assertScriptVersion(db, parsed.data.projectId, source);
    const content = String(row.content ?? "");
    scripts.push({ id: source.id, name: String(row.name ?? ""), content, contentHash: scriptContentHash(content), version: source.expectedVersion });
  }
  if (JSON.stringify(scripts).length > 500_000) throw new AssetExtractionWorkspaceError("INVALID_INPUT", "选定剧本过长，请分批提取素材");
  const rows = await db("o_assets")
    .where({ projectId: parsed.data.projectId })
    .whereNull("assetsId")
    .whereIn("type", ROOT_TYPES as unknown as string[])
    .orderBy("id")
    .select("id", "name", "type", "describe", "prompt");
  if (rows.length > 5000) throw new AssetExtractionWorkspaceError("INVALID_INPUT", "项目素材过多，请缩小提取范围");
  const ids = rows.map((row: any) => Number(row.id));
  const states = ids.length ? await db("ext_creative_state").where({ projectId: parsed.data.projectId, entityType: "asset" }).whereIn("entityId", ids) : [];
  const versions = new Map(states.map((row: any) => [Number(row.entityId), Number(row.version)]));
  const locked = await lockedAssetIds(db, ids);
  return {
    project: { id: parsed.data.projectId, name: String(project.name ?? ""), artStyle: String(project.artStyle ?? ""), type: String(project.type ?? "") },
    workspaceVersion: (await getCreativeState(db, "scriptPlan", parsed.data.projectId, parsed.data.projectId)).version,
    scripts,
    assets: rows.map((row: any) => ({
      id: Number(row.id),
      name: String(row.name ?? ""),
      type: row.type as RootAssetType,
      description: String(row.describe ?? ""),
      prompt: String(row.prompt ?? ""),
      version: versions.get(Number(row.id)) ?? 0,
      locked: locked.has(Number(row.id)),
    })),
  };
}

async function assertNoLockedBindingRemoval(trx: Knex.Transaction, scriptId: number, removedAssetIds: number[]): Promise<void> {
  if (!removedAssetIds.length) return;
  const row = await trx("o_assets2Storyboard as link")
    .join("o_storyboard as storyboard", "storyboard.id", "link.storyboardId")
    .join("ext_entity_state as state", function joinState() {
      this.on("state.entityType", "=", trx.raw("?", ["storyboard"]))
        .andOn("state.entityId", "=", "storyboard.id")
        .andOn("state.locked", "=", trx.raw("?", [1]));
    })
    .where("storyboard.scriptId", scriptId)
    .whereIn("link.assetId", removedAssetIds)
    .first();
  if (row) throw new AssetExtractionWorkspaceError("LOCKED", "锁定分镜正在引用待移除素材，不能修改剧集素材绑定");
}

async function applyInTransaction(trx: Knex.Transaction, raw: ApplyAssetExtractionInput): Promise<AssetExtractionReceipt> {
  const { actor, ...body } = raw;
  validateActor(actor);
  const parsed = applyAssetExtractionSchema.safeParse(body);
  if (!parsed.success) throw new AssetExtractionWorkspaceError("INVALID_INPUT", parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;
  if (new Set(input.sourceScripts.map((source) => source.id)).size !== input.sourceScripts.length) throw new AssetExtractionWorkspaceError("INVALID_INPUT", "同一剧集不能重复提取");
  await lockProjectTransaction(trx, input.projectId);
  const receiptKey = { actorId: actor.id, projectId: input.projectId, idempotencyKey: input.idempotencyKey };
  const requestHash = hash(input);
  const previous = await trx(RECEIPTS).where(receiptKey).first();
  if (previous) {
    if (previous.requestHash !== requestHash) throw new AssetExtractionWorkspaceError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同的素材提取结果");
    const result = typeof previous.result === "string" ? JSON.parse(previous.result) : previous.result;
    return { ...result, reused: true };
  }
  await assertProject(trx, input.projectId);
  const workspaceState = await getCreativeState(trx, "scriptPlan", input.projectId, input.projectId);
  if (workspaceState.version !== input.expectedWorkspaceVersion) throw new AssetExtractionWorkspaceError("VERSION_CONFLICT", "剧本工作区已被修改");
  for (const source of input.sourceScripts) await assertScriptVersion(trx, input.projectId, source);

  const all = decisions(input.proposal);
  const createKeys = all.filter((item) => item.decision.action === "create").map((item) => (item.decision as z.infer<typeof createAssetDecisionSchema>).key);
  if (new Set(createKeys).size !== createKeys.length) throw new AssetExtractionWorkspaceError("INVALID_INPUT", "新素材 key 不能重复");
  const existingDecisions = all.filter((item) => item.decision.action !== "create") as Array<{
    group: AssetSemanticGroup;
    type: RootAssetType;
    decision: z.infer<typeof reuseAssetDecisionSchema> | z.infer<typeof updateAssetDecisionSchema>;
  }>;
  const existingIds = existingDecisions.map((item) => item.decision.assetId);
  if (new Set(existingIds).size !== existingIds.length) throw new AssetExtractionWorkspaceError("INVALID_INPUT", "已有素材 ID 不能重复声明");

  const existingRows = existingIds.length ? await trx("o_assets").whereIn("id", existingIds).select("*") : [];
  const rowsById = new Map(existingRows.map((row: any) => [Number(row.id), row]));
  for (const item of existingDecisions) {
    const row = rowsById.get(item.decision.assetId);
    if (!row) throw new AssetExtractionWorkspaceError("NOT_FOUND", `素材 ${item.decision.assetId} 不存在`);
    if (Number(row.projectId) !== input.projectId) throw new AssetExtractionWorkspaceError("PROJECT_MISMATCH", `素材 ${item.decision.assetId} 不属于指定项目`);
    if (row.assetsId != null || !ROOT_TYPES.includes(row.type) || row.type !== item.type) {
      throw new AssetExtractionWorkspaceError("TYPE_MISMATCH", `素材 ${item.decision.assetId} 不是对应类别的顶层视觉素材`);
    }
    const state = await getCreativeState(trx, "asset", item.decision.assetId, input.projectId);
    if (state.version !== item.decision.expectedVersion) throw new AssetExtractionWorkspaceError("VERSION_CONFLICT", `素材 ${item.decision.assetId} 已被修改`);
  }
  const updateIds = existingDecisions.filter((item) => item.decision.action === "update").map((item) => item.decision.assetId);
  const lockedUpdates = await lockedAssetIds(trx, updateIds);
  if (lockedUpdates.size) throw new AssetExtractionWorkspaceError("LOCKED", "锁定分镜引用了待编辑素材");

  const existingNames = await trx("o_assets")
    .where({ projectId: input.projectId })
    .whereNull("assetsId")
    .whereIn("type", ROOT_TYPES as unknown as string[])
    .select("id", "name", "type");
  const names = new Set(existingNames.map((row: any) => `${row.type}\u0000${String(row.name ?? "").trim()}`));
  for (const item of all) {
    if (item.decision.action !== "create") continue;
    const nameKey = `${item.type}\u0000${item.decision.name.trim()}`;
    if (names.has(nameKey)) throw new AssetExtractionWorkspaceError("INVALID_INPUT", `同项目已有同名 ${item.type} 素材；复用时必须返回其真实 ID`);
    names.add(nameKey);
  }

  const resolvedCreated = new Map<string, number>();
  const createdAssetIds: number[] = [];
  const updatedAssetIds: number[] = [];
  for (const item of all) {
    if (item.decision.action === "create") {
      const [assetId] = await insertRowsReturningIds(trx, "o_assets", {
        projectId: input.projectId,
        name: item.decision.name,
        type: item.type,
        describe: item.decision.description,
        prompt: item.decision.prompt,
        startTime: Date.now(),
      });
      await advanceCreativeState(trx, { entityType: "asset", entityId: assetId, projectId: input.projectId, expectedVersion: 0, actor });
      resolvedCreated.set(item.decision.key, assetId);
      createdAssetIds.push(assetId);
      continue;
    }
    if (item.decision.action === "update") {
      const patch: Record<string, unknown> = {};
      if (item.decision.name !== undefined) patch.name = item.decision.name;
      if (item.decision.description !== undefined) patch.describe = item.decision.description;
      if (item.decision.prompt !== undefined) patch.prompt = item.decision.prompt;
      await trx("o_assets").where({ id: item.decision.assetId, projectId: input.projectId }).update(patch);
      await advanceCreativeState(trx, { entityType: "asset", entityId: item.decision.assetId, projectId: input.projectId, expectedVersion: item.decision.expectedVersion, actor });
      updatedAssetIds.push(item.decision.assetId);
    }
  }

  const declaredExisting = new Set(existingIds);
  const sourceById = new Map(input.sourceScripts.map((source) => [source.id, source]));
  const bindings = input.proposal.bindings ?? [];
  if (new Set(bindings.map((binding) => binding.scriptId)).size !== bindings.length) throw new AssetExtractionWorkspaceError("INVALID_INPUT", "同一剧集的绑定结果不能重复");
  const bindingResults: AssetExtractionReceipt["bindings"] = [];
  for (const binding of bindings) {
    const source = sourceById.get(binding.scriptId);
    if (!source) throw new AssetExtractionWorkspaceError("PROJECT_MISMATCH", "只能绑定本次指定且已验证版本的剧集");
    const resolved = binding.assets.map((ref) => {
      if (ref.kind === "existing") {
        if (!declaredExisting.has(ref.assetId)) throw new AssetExtractionWorkspaceError("INVALID_INPUT", `绑定素材 ${ref.assetId} 未在复用或编辑列表中显式声明`);
        return ref.assetId;
      }
      const id = resolvedCreated.get(ref.key);
      if (!id) throw new AssetExtractionWorkspaceError("INVALID_INPUT", `绑定引用了未知的新素材 key: ${ref.key}`);
      return id;
    });
    if (new Set(resolved).size !== resolved.length) throw new AssetExtractionWorkspaceError("INVALID_INPUT", "同一剧集不能重复绑定同一素材");
    const oldRows = await trx("o_scriptAssets").where({ scriptId: binding.scriptId }).select("assetId");
    const oldIds = oldRows.map((row: any) => Number(row.assetId));
    const next = new Set(resolved);
    await assertNoLockedBindingRemoval(trx, binding.scriptId, oldIds.filter((id) => !next.has(id)));
    await trx("o_scriptAssets").where({ scriptId: binding.scriptId }).delete();
    if (resolved.length) await trx("o_scriptAssets").insert(resolved.map((assetId) => ({ scriptId: binding.scriptId, assetId })));
    const state = await advanceCreativeState(trx, { entityType: "script", entityId: binding.scriptId, projectId: input.projectId, expectedVersion: source.expectedVersion, actor });
    await trx("o_script").where({ id: binding.scriptId, projectId: input.projectId }).update({ extractState: 1, errorReason: null });
    bindingResults.push({ scriptId: binding.scriptId, assetIds: resolved, version: state.version });
  }

  let workspaceVersion = input.expectedWorkspaceVersion;
  if (bindings.length) {
    workspaceVersion = (await advanceCreativeState(trx, {
      entityType: "scriptPlan",
      entityId: input.projectId,
      projectId: input.projectId,
      expectedVersion: input.expectedWorkspaceVersion,
      actor,
    })).version;
  }

  const result: AssetExtractionReceipt = {
    projectId: input.projectId,
    assetIds: [...existingIds, ...createdAssetIds],
    createdAssetIds,
    updatedAssetIds,
    bindings: bindingResults,
    workspaceVersion,
    reused: false,
  };
  await trx(RECEIPTS).insert({ ...receiptKey, requestHash, result: JSON.stringify(result), createdAt: Date.now() });
  return result;
}

export async function applyAssetExtractionInTransaction(trx: Knex.Transaction, input: ApplyAssetExtractionInput): Promise<AssetExtractionReceipt> {
  if (!(trx as Knex.Transaction).isTransaction) throw new AssetExtractionWorkspaceError("INVALID_INPUT", "素材提取提交必须在事务中执行");
  return applyInTransaction(trx, input);
}

export async function applyAssetExtraction(db: Knex, input: ApplyAssetExtractionInput): Promise<AssetExtractionReceipt> {
  return db.transaction((trx) => applyInTransaction(trx, input));
}
