import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { insertRowsReturningIds } from "../lib/insertRows";
import { isPostgres, lockProjectTransaction } from "../lib/dbTransaction";
import {
  advanceCreativeState,
  CreativeWorkspaceError,
  ensureCreativeWorkspaceSchema,
  getCreativeState,
} from "./creativeWorkspace";
import { notifyProductionChange } from "./productionEvents";
import { ensureProductionStateSchema, type TrustedActor } from "./productionState";
import { resolveImageFlowOwner, ImageFlowWorkspaceError } from "./imageFlowWorkspace";
import { assertImageMediaProject, MediaOwnershipError } from "../lib/mediaOwnership";

const RECEIPTS = "ext_derived_asset_mutations";
const ROOT_ASSET_TYPES = ["role", "scene", "tool"];

export class ProductionAssetError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "PROJECT_MISMATCH"
      | "VERSION_CONFLICT"
      | "IDEMPOTENCY_CONFLICT"
      | "LOCKED" = status === 423 ? "LOCKED" : status === 409 ? "VERSION_CONFLICT" : status === 404 ? "NOT_FOUND" : "INVALID_INPUT",
  ) {
    super(message);
    this.name = "ProductionAssetError";
  }
}

export interface DerivedAssetInput {
  projectId: number;
  scriptId: number;
  parentAssetId: number;
  id?: number | null;
  expectedVersion?: number;
  name: string;
  description: string;
  idempotencyKey?: string;
  actor?: TrustedActor;
}

export interface DeleteDerivedAssetInput {
  projectId: number;
  scriptId: number;
  parentAssetId?: number;
  id: number;
  expectedVersion?: number;
  idempotencyKey?: string;
  actor?: TrustedActor;
}

export interface UpdateDerivedAssetImageInput {
  projectId: number;
  scriptId: number;
  id: number;
  url: string;
  flowId: number;
  expectedVersion?: number;
  idempotencyKey?: string;
  actor?: TrustedActor;
}

interface MutationIdentity {
  actor: TrustedActor;
  key?: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

const requestHash = (operation: string, value: unknown): string => createHash("sha256").update(canonical({ operation, value })).digest("hex");

function positive(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ProductionAssetError(`${field} 无效`, 400, "INVALID_INPUT");
  return parsed;
}

function requiredVersion(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ProductionAssetError("更新已有衍生素材必须提供 expectedVersion", 400, "INVALID_INPUT");
  return parsed;
}

function mutationIdentity(input: { actor?: TrustedActor; idempotencyKey?: string }): MutationIdentity {
  const actor = input.actor ?? { id: "system:legacy-production", kind: "system" as const };
  if (!actor.id || actor.id.length > 250 || !["human", "agent", "system"].includes(actor.kind)) {
    throw new ProductionAssetError("缺少可信操作身份", 400, "INVALID_INPUT");
  }
  if (input.idempotencyKey !== undefined && !/^[\w:.-]{8,180}$/.test(input.idempotencyKey)) {
    throw new ProductionAssetError("幂等操作编号无效", 400, "INVALID_INPUT");
  }
  return { actor, key: input.idempotencyKey };
}

function translateCreativeError(error: unknown): never {
  if (!(error instanceof CreativeWorkspaceError)) throw error;
  if (error.code === "VERSION_CONFLICT") throw new ProductionAssetError(error.message, 409, "VERSION_CONFLICT");
  if (error.code === "PROJECT_MISMATCH") throw new ProductionAssetError(error.message, 404, "PROJECT_MISMATCH");
  if (error.code === "NOT_FOUND") throw new ProductionAssetError(error.message, 404, "NOT_FOUND");
  throw new ProductionAssetError(error.message, 400, "INVALID_INPUT");
}

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

async function readReceipt<T>(trx: Knex.Transaction, identity: MutationIdentity, projectId: number, hash: string): Promise<T | undefined> {
  if (!identity.key) return undefined;
  const row = await trx(RECEIPTS).where({ actorId: identity.actor.id, projectId, idempotencyKey: identity.key }).first();
  if (!row) return undefined;
  if (row.requestHash !== hash) throw new ProductionAssetError("幂等操作编号已用于不同内容", 409, "IDEMPOTENCY_CONFLICT");
  return (typeof row.result === "string" ? JSON.parse(row.result) : row.result) as T;
}

async function saveReceipt(trx: Knex.Transaction, identity: MutationIdentity, projectId: number, hash: string, result: unknown): Promise<void> {
  if (!identity.key) return;
  await trx(RECEIPTS).insert({ actorId: identity.actor.id, projectId, idempotencyKey: identity.key, requestHash: hash, result: JSON.stringify(result), createdAt: Date.now() });
}

export async function ensureProductionAssetSchema(db: Knex): Promise<void> {
  await ensureCreativeWorkspaceSchema(db);
  await ensureProductionStateSchema(db);
  await db.transaction(async (trx) => {
    if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["toonflow:derived-asset-schema"]);
    if (!(await trx.schema.hasTable(RECEIPTS))) {
      await trx.schema.createTable(RECEIPTS, (table) => {
        table.text("actorId").notNullable();
        table.bigInteger("projectId").notNullable();
        table.text("idempotencyKey").notNullable();
        table.text("requestHash").notNullable();
        table.text("result").notNullable();
        table.bigInteger("createdAt").notNullable();
        table.primary(["actorId", "projectId", "idempotencyKey"]);
      });
    }
  });
}

async function assertEpisode(db: Knex | Knex.Transaction, projectId: number, scriptId: number): Promise<void> {
  const script = await db("o_script").where({ id: scriptId, projectId }).first();
  if (!script) throw new ProductionAssetError("剧集不属于当前项目", 404, "PROJECT_MISMATCH");
}

async function assertParentBinding(db: Knex.Transaction, input: { projectId: number; scriptId: number; parentAssetId: number }): Promise<any> {
  await assertEpisode(db, input.projectId, input.scriptId);
  const parent = await db("o_assets").where({ id: input.parentAssetId, projectId: input.projectId }).first();
  if (!parent) throw new ProductionAssetError("父素材不属于当前项目", 404, "PROJECT_MISMATCH");
  if (parent.assetsId != null || !ROOT_ASSET_TYPES.includes(String(parent.type))) {
    throw new ProductionAssetError("父素材必须是角色、场景或道具顶层素材", 400, "PROJECT_MISMATCH");
  }
  const linked = await db("o_scriptAssets").where({ scriptId: input.scriptId, assetId: input.parentAssetId }).first();
  if (!linked) throw new ProductionAssetError("父素材未绑定到当前剧集", 400, "PROJECT_MISMATCH");
  return parent;
}

async function assertChildBinding(
  trx: Knex.Transaction,
  input: { projectId: number; scriptId: number; id: number; parentAssetId?: number },
): Promise<{ child: any; parent: any }> {
  await assertEpisode(trx, input.projectId, input.scriptId);
  const child = await trx("o_assets").where({ id: input.id, projectId: input.projectId }).whereNotNull("assetsId").first();
  if (!child) throw new ProductionAssetError("衍生素材不属于当前项目", 404, "PROJECT_MISMATCH");
  if (input.parentAssetId != null && Number(child.assetsId) !== input.parentAssetId) {
    throw new ProductionAssetError("衍生素材不属于指定父素材", 404, "PROJECT_MISMATCH");
  }
  const links = await trx("o_scriptAssets").where({ assetId: input.id }).select("scriptId");
  if (!links.some((row: any) => Number(row.scriptId) === input.scriptId) || links.some((row: any) => Number(row.scriptId) !== input.scriptId)) {
    throw new ProductionAssetError("衍生素材未唯一绑定到当前剧集", 400, "PROJECT_MISMATCH");
  }
  const parent = await assertParentBinding(trx, { projectId: input.projectId, scriptId: input.scriptId, parentAssetId: Number(child.assetsId) });
  if (String(child.type) !== String(parent.type)) throw new ProductionAssetError("衍生素材类型与父素材不一致", 400, "PROJECT_MISMATCH");
  return { child, parent };
}

async function assetVersion(db: Knex | Knex.Transaction, projectId: number, assetId: number): Promise<number> {
  try {
    return (await getCreativeState(db as Knex, "asset", assetId, projectId)).version;
  } catch (error) {
    translateCreativeError(error);
  }
}

async function advanceAsset(trx: Knex.Transaction, input: { projectId: number; assetId: number; expectedVersion: number; actor: TrustedActor }): Promise<number> {
  try {
    return (await advanceCreativeState(trx, { entityType: "asset", entityId: input.assetId, projectId: input.projectId, expectedVersion: input.expectedVersion, actor: input.actor })).version;
  } catch (error) {
    translateCreativeError(error);
  }
}

export async function assertAssetNotLockedReference(db: Knex.Transaction, assetId: number): Promise<void> {
  const lockedReference = await db("o_assets2Storyboard as link")
    .join("ext_entity_state as state", function joinState() {
      this.on("state.entityType", "=", db.raw("?", ["storyboard"]))
        .andOn("state.entityId", "=", "link.storyboardId")
        .andOn("state.locked", "=", db.raw("?", [1]));
    })
    .where("link.assetId", assetId)
    .first();
  if (lockedReference) throw new ProductionAssetError("锁定分镜引用了该素材，不能修改或删除", 423, "LOCKED");
}

async function assertFlowOwnership(trx: Knex.Transaction, projectId: number, scriptId: number, childId: number, flowId: number): Promise<void> {
  let owner;
  try { owner = await resolveImageFlowOwner(trx, flowId); }
  catch (error) { if (error instanceof ImageFlowWorkspaceError) throw new ProductionAssetError(error.message, 403, "PROJECT_MISMATCH"); throw error; }
  if (owner.projectId !== projectId || owner.scriptId !== scriptId) throw new ProductionAssetError("图片工作流不属于当前项目和剧集", 403, "PROJECT_MISMATCH");
  if (!(await trx("o_imageFlow").where({ id: flowId }).forUpdate().first())) throw new ProductionAssetError("图片工作流不存在", 404, "NOT_FOUND");
  const [assets, storyboards] = await Promise.all([
    trx("o_assets").where({ flowId }).select("id", "projectId"),
    trx("o_storyboard").where({ flowId }).select("id", "projectId"),
  ]);
  if (storyboards.length || assets.some((row: any) => Number(row.projectId) !== projectId || Number(row.id) !== childId)) {
    throw new ProductionAssetError("图片工作流已属于其他项目或资源", 400, "PROJECT_MISMATCH");
  }
}

async function resolveCandidateImage(trx: Knex.Transaction, input: { projectId: number; child: any; url: string }): Promise<{ imageId: number; created: boolean }> {
  try { input.url = await assertImageMediaProject(trx, input.projectId, input.url); }
  catch (error) { if (error instanceof MediaOwnershipError) throw new ProductionAssetError(error.message, 403, "PROJECT_MISMATCH"); throw error; }
  const relativePath = input.url.replace(/^\/+/, "");
  if (!relativePath.startsWith(`${input.projectId}/`) || input.url.includes("..") || input.url.includes("\\") || input.url.includes("\0")) {
    throw new ProductionAssetError("候选图片路径不属于当前项目", 400, "PROJECT_MISMATCH");
  }
  const rows = await trx("o_image").where({ filePath: input.url }).select("id", "assetsId", "state");
  if (rows.some((row: any) => Number(row.assetsId) !== Number(input.child.id))) {
    throw new ProductionAssetError("候选图片属于其他素材", 400, "PROJECT_MISMATCH");
  }
  const existing = rows.find((row: any) => Number(row.assetsId) === Number(input.child.id));
  if (existing) {
    if (existing.state !== "已完成") throw new ProductionAssetError("候选图片尚未完成", 409, "VERSION_CONFLICT");
    return { imageId: Number(existing.id), created: false };
  }
  const [imageId] = await insertRowsReturningIds(trx, "o_image", { filePath: input.url, state: "已完成", assetsId: input.child.id, type: input.child.type });
  return { imageId, created: true };
}

export async function createOrUpdateDerivedAsset(db: Knex, raw: DerivedAssetInput) {
  const input = {
    ...raw,
    projectId: positive(raw.projectId, "projectId"),
    scriptId: positive(raw.scriptId, "scriptId"),
    parentAssetId: positive(raw.parentAssetId, "parentAssetId"),
  };
  const identity = mutationIdentity(input);
  const existingId = input.id == null ? undefined : positive(input.id, "id");
  const expectedVersion = existingId == null ? undefined : requiredVersion(input.expectedVersion);
  const hash = requestHash("upsert", { ...input, actor: undefined, idempotencyKey: undefined, id: existingId ?? null, expectedVersion });
  const result = await inProject(db, input.projectId, async (trx) => {
    const replay = await readReceipt<any>(trx, identity, input.projectId, hash);
    if (replay) return { ...replay, reused: true };
    const parent = await assertParentBinding(trx, input);
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 500 || typeof input.description !== "string" || input.description.length > 20_000) {
      throw new ProductionAssetError("衍生素材名称或描述无效", 400, "INVALID_INPUT");
    }
    if (existingId != null) {
      await assertChildBinding(trx, { projectId: input.projectId, scriptId: input.scriptId, parentAssetId: input.parentAssetId, id: existingId });
      await assertAssetNotLockedReference(trx, existingId);
      const currentVersion = await assetVersion(trx, input.projectId, existingId);
      if (currentVersion !== expectedVersion) throw new ProductionAssetError("衍生素材已被修改，请重新载入", 409, "VERSION_CONFLICT");
      const version = await advanceAsset(trx, { projectId: input.projectId, assetId: existingId, expectedVersion, actor: identity.actor });
      await trx("o_assets").where({ id: existingId, projectId: input.projectId, assetsId: input.parentAssetId }).update({ scriptId: input.scriptId, name: input.name.trim(), type: parent.type, describe: input.description });
      const output = { id: existingId, created: false, parentAssetId: input.parentAssetId, version };
      await saveReceipt(trx, identity, input.projectId, hash, output);
      return { ...output, reused: false };
    }
    const [id] = await insertRowsReturningIds(trx, "o_assets", {
      assetsId: input.parentAssetId,
      projectId: input.projectId,
      scriptId: input.scriptId,
      name: input.name.trim(),
      type: parent.type,
      describe: input.description,
      startTime: Date.now(),
    });
    await trx("o_scriptAssets").insert({ scriptId: input.scriptId, assetId: id });
    const version = await advanceAsset(trx, { projectId: input.projectId, assetId: id, expectedVersion: 0, actor: identity.actor });
    const output = { id: Number(id), created: true, parentAssetId: input.parentAssetId, version };
    await saveReceipt(trx, identity, input.projectId, hash, output);
    return { ...output, reused: false };
  });
  if (!(db as Knex.Transaction).isTransaction && !result.reused) notifyProductionChange({ projectId: input.projectId, scriptId: input.scriptId });
  return result;
}

export async function deleteDerivedAsset(db: Knex, raw: DeleteDerivedAssetInput) {
  const input = { ...raw, projectId: positive(raw.projectId, "projectId"), scriptId: positive(raw.scriptId, "scriptId"), id: positive(raw.id, "id") };
  const identity = mutationIdentity(input);
  const expectedVersion = requiredVersion(input.expectedVersion);
  const parentAssetId = input.parentAssetId == null ? undefined : positive(input.parentAssetId, "parentAssetId");
  const hash = requestHash("delete", { ...input, actor: undefined, idempotencyKey: undefined, parentAssetId: parentAssetId ?? null, expectedVersion });
  const result = await inProject(db, input.projectId, async (trx) => {
    const replay = await readReceipt<any>(trx, identity, input.projectId, hash);
    if (replay) return { ...replay, reused: true };
    const { child } = await assertChildBinding(trx, { projectId: input.projectId, scriptId: input.scriptId, parentAssetId, id: input.id });
    await assertAssetNotLockedReference(trx, input.id);
    const currentVersion = await assetVersion(trx, input.projectId, input.id);
    if (currentVersion !== expectedVersion) throw new ProductionAssetError("衍生素材已被修改，请重新载入", 409, "VERSION_CONFLICT");
    const flowId = child.flowId;
    await trx("o_assets2Storyboard").where({ assetId: input.id }).delete();
    await trx("o_scriptAssets").where({ scriptId: input.scriptId, assetId: input.id }).delete();
    await trx("o_image").where({ assetsId: input.id }).delete();
    await trx("o_assets").where({ id: input.id, projectId: input.projectId }).delete();
    await trx("ext_creative_state").where({ entityType: "asset", entityId: input.id, projectId: input.projectId }).delete();
    if (flowId != null && !(await trx("o_assets").where({ flowId }).first()) && !(await trx("o_storyboard").where({ flowId }).first())) {
      await trx("o_imageFlow").where({ id: flowId }).delete();
      if (await trx.schema.hasTable("ext_image_flow_owners")) await trx("ext_image_flow_owners").where({ flowId }).delete();
      await trx("ext_creative_state").where({ entityType: "imageFlow", entityId: flowId, projectId: input.projectId }).delete();
    }
    const output = { id: input.id, deleted: true, parentAssetId: Number(child.assetsId), version: expectedVersion + 1 };
    await saveReceipt(trx, identity, input.projectId, hash, output);
    return { ...output, reused: false };
  });
  if (!(db as Knex.Transaction).isTransaction && !result.reused) notifyProductionChange({ projectId: input.projectId, scriptId: input.scriptId });
  return result;
}

export async function updateDerivedAssetImage(db: Knex, raw: UpdateDerivedAssetImageInput) {
  const input = { ...raw, projectId: positive(raw.projectId, "projectId"), scriptId: positive(raw.scriptId, "scriptId"), id: positive(raw.id, "id"), flowId: positive(raw.flowId, "flowId") };
  const identity = mutationIdentity(input);
  const expectedVersion = requiredVersion(input.expectedVersion);
  const hash = requestHash("select-image", { ...input, actor: undefined, idempotencyKey: undefined, expectedVersion });
  const result = await inProject(db, input.projectId, async (trx) => {
    const replay = await readReceipt<any>(trx, identity, input.projectId, hash);
    if (replay) return { ...replay, reused: true };
    const { child } = await assertChildBinding(trx, { projectId: input.projectId, scriptId: input.scriptId, id: input.id });
    await assertAssetNotLockedReference(trx, input.id);
    const currentVersion = await assetVersion(trx, input.projectId, input.id);
    if (currentVersion !== expectedVersion) throw new ProductionAssetError("衍生素材已被修改，请重新载入", 409, "VERSION_CONFLICT");
    await assertFlowOwnership(trx, input.projectId, input.scriptId, input.id, input.flowId);
    if (typeof input.url !== "string") throw new ProductionAssetError("候选图片路径无效", 400, "INVALID_INPUT");
    const candidate = await resolveCandidateImage(trx, { projectId: input.projectId, child, url: input.url });
    const version = await advanceAsset(trx, { projectId: input.projectId, assetId: input.id, expectedVersion, actor: identity.actor });
    await trx("o_assets").where({ id: input.id, projectId: input.projectId, assetsId: child.assetsId }).update({ scriptId: input.scriptId, flowId: input.flowId, imageId: candidate.imageId });
    const output = { id: input.id, imageId: candidate.imageId, flowId: input.flowId, version, candidateCreated: candidate.created };
    await saveReceipt(trx, identity, input.projectId, hash, output);
    return { ...output, reused: false };
  });
  if (!(db as Knex.Transaction).isTransaction && !result.reused) notifyProductionChange({ projectId: input.projectId, scriptId: input.scriptId });
  return result;
}
