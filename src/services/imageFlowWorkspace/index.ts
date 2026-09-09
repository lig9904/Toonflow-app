import { createHash } from "node:crypto";
import type { Knex } from "knex";
import sharp from "sharp";
import { z } from "zod";
import { isPostgres, lockProjectTransaction } from "../../lib/dbTransaction";
import { insertRowsReturningIds } from "../../lib/insertRows";
import { assertImageMediaProject, MediaOwnershipError } from "../../lib/mediaOwnership";
import {
  advanceCreativeState,
  CreativeWorkspaceError,
  ensureCreativeWorkspaceSchema,
  getCreativeState,
} from "../creativeWorkspace";
import type { TrustedActor } from "../productionState";

const OWNERS = "ext_image_flow_owners";
const MEDIA = "ext_media_files";
const RECEIPTS = "ext_image_flow_mutations";

export class ImageFlowWorkspaceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "PROJECT_MISMATCH"
      | "VERSION_CONFLICT"
      | "IDEMPOTENCY_CONFLICT"
      | "AMBIGUOUS_OWNER",
    message: string,
  ) {
    super(message);
    this.name = "ImageFlowWorkspaceError";
  }
}

export interface ImageFlowStorage {
  write(path: string, data: Buffer): Promise<void>;
}

const positiveId = z.coerce.number().int().positive();
const versionSchema = z.coerce.number().int().nonnegative();
const mutationKeySchema = z.string().min(8).max(180).regex(/^[\w:.-]+$/);
const mediaPathSchema = z.string().max(5_000);
const positionSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const uploadNodeSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal("upload"),
  position: positionSchema,
  data: z.object({ image: mediaPathSchema }).strict(),
}).strict();
const generatedNodeSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal("generated"),
  position: positionSchema,
  data: z.object({
    generatedImage: mediaPathSchema.optional(),
    references: z.array(z.object({ image: mediaPathSchema }).strict()).max(100),
    prompt: z.string().max(20_480),
    model: z.string().max(500).optional(),
    ratio: z.string().max(50).optional(),
    quality: z.string().max(50).optional(),
  }).strict(),
}).strict();
const nodeSchema = z.discriminatedUnion("type", [uploadNodeSchema, generatedNodeSchema]);
const edgeSchema = z.object({
  id: z.string().min(1).max(200),
  source: z.string().min(1).max(200),
  target: z.string().min(1).max(200),
}).strict();
const documentSchema = z.object({ nodes: z.array(nodeSchema).max(500), edges: z.array(edgeSchema).max(2_000) }).strict();

export type ImageFlowDocument = z.infer<typeof documentSchema>;
export interface ImageFlowOwner { flowId: number; projectId: number; scriptId: number; }
export interface ImageFlowView extends ImageFlowDocument, ImageFlowOwner { id: number; version: number; }

const createSchema = documentSchema.extend({
  projectId: positiveId,
  scriptId: positiveId,
  expectedVersion: z.literal(0),
  idempotencyKey: mutationKeySchema,
}).strict();
const updateSchema = documentSchema.extend({
  flowId: positiveId,
  projectId: positiveId,
  scriptId: positiveId,
  expectedVersion: versionSchema,
  idempotencyKey: mutationKeySchema,
}).strict();
const uploadSchema = z.object({
  projectId: positiveId,
  scriptId: positiveId,
  base64Data: z.string(),
  idempotencyKey: mutationKeySchema,
}).strict();

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function requestHash(operation: string, value: unknown): string { return digest(stableJson({ operation, value })); }

function actorId(actor: TrustedActor): string {
  if (!actor || !["human", "agent", "system"].includes(actor.kind) || typeof actor.id !== "string" || !actor.id.trim() || actor.id.length > 250) {
    throw new ImageFlowWorkspaceError("INVALID_INPUT", "缺少可信操作身份");
  }
  return actor.id;
}

function translate(error: unknown): never {
  if (error instanceof ImageFlowWorkspaceError) throw error;
  if (error instanceof MediaOwnershipError) {
    if (error.code === "PROJECT_MISMATCH") throw new ImageFlowWorkspaceError("PROJECT_MISMATCH", error.message);
    if (error.code === "AMBIGUOUS_OWNER") throw new ImageFlowWorkspaceError("AMBIGUOUS_OWNER", error.message);
    throw new ImageFlowWorkspaceError(error.code, error.message);
  }
  if (error instanceof CreativeWorkspaceError) {
    if (error.code === "VERSION_CONFLICT") throw new ImageFlowWorkspaceError("VERSION_CONFLICT", error.message);
    if (error.code === "PROJECT_MISMATCH") throw new ImageFlowWorkspaceError("PROJECT_MISMATCH", error.message);
    throw new ImageFlowWorkspaceError(error.code === "NOT_FOUND" ? "NOT_FOUND" : "INVALID_INPUT", error.message);
  }
  throw error;
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

export async function ensureImageFlowWorkspaceSchema(db: Knex): Promise<void> {
  await ensureCreativeWorkspaceSchema(db);
  await db.transaction(async (trx) => {
    if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["toonflow:image-flow-workspace-schema"]);
    if (!(await trx.schema.hasTable(OWNERS))) {
      await trx.schema.createTable(OWNERS, (table) => {
        table.bigInteger("flowId").primary();
        table.bigInteger("projectId").notNullable();
        table.bigInteger("scriptId").notNullable();
        table.text("createdBy").notNullable();
        table.bigInteger("createdAt").notNullable();
        table.index(["projectId", "scriptId"]);
      });
    }
    if (!(await trx.schema.hasTable(MEDIA))) {
      await trx.schema.createTable(MEDIA, (table) => {
        table.text("filePath").primary();
        table.bigInteger("projectId").notNullable();
        table.bigInteger("scriptId").notNullable();
        table.text("kind").notNullable();
        table.text("mime").notNullable();
        table.text("sha256").notNullable();
        table.bigInteger("byteSize").notNullable();
        table.text("createdBy").notNullable();
        table.bigInteger("createdAt").notNullable();
        table.unique(["projectId", "scriptId", "sha256"]);
        table.index(["projectId", "kind"]);
      });
    }
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
  if (!(await db("o_project").where({ id: projectId }).first())) throw new ImageFlowWorkspaceError("NOT_FOUND", "项目不存在");
  if (!(await db("o_script").where({ id: scriptId, projectId }).first())) throw new ImageFlowWorkspaceError("PROJECT_MISMATCH", "剧集不属于当前项目");
}

async function readReceipt<T>(trx: Knex.Transaction, actor: string, projectId: number, key: string, hash: string): Promise<T | undefined> {
  const row = await trx(RECEIPTS).where({ actorId: actor, projectId, idempotencyKey: key }).first();
  if (!row) return undefined;
  if (row.requestHash !== hash) throw new ImageFlowWorkspaceError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同内容");
  return JSON.parse(row.result) as T;
}

async function saveReceipt(trx: Knex.Transaction, actor: string, projectId: number, key: string, hash: string, result: unknown): Promise<void> {
  await trx(RECEIPTS).insert({ actorId: actor, projectId, idempotencyKey: key, requestHash: hash, result: JSON.stringify(result), createdAt: Date.now() });
}

function parseImageDataUrl(value: string): { mime: string; data: Buffer; ext: string } {
  const match = value.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) throw new ImageFlowWorkspaceError("INVALID_INPUT", "仅支持 PNG、JPEG 或 WEBP Data URL");
  const data = Buffer.from(match[2], "base64");
  if (!data.length || data.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) throw new ImageFlowWorkspaceError("INVALID_INPUT", "图片 base64 数据损坏");
  const mime = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
  return { mime, data, ext: mime === "image/jpeg" ? "jpg" : mime.slice("image/".length) };
}

async function validateOriginalImage(value: string): Promise<{ mime: string; data: Buffer; ext: string; sha256: string }> {
  const parsed = parseImageDataUrl(value);
  let metadata: sharp.Metadata;
  try { metadata = await sharp(parsed.data).metadata(); }
  catch { throw new ImageFlowWorkspaceError("INVALID_INPUT", "图片无法解码"); }
  const decodedMime = metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`;
  if (!metadata.width || !metadata.height || decodedMime !== parsed.mime) throw new ImageFlowWorkspaceError("INVALID_INPUT", "图片内容与声明类型不一致");
  return { ...parsed, sha256: digest(parsed.data) };
}

export async function uploadImageFlowMedia(db: Knex, raw: unknown, actor: TrustedActor, storage: ImageFlowStorage) {
  await ensureImageFlowWorkspaceSchema(db);
  const parsed = uploadSchema.safeParse(raw);
  if (!parsed.success) throw new ImageFlowWorkspaceError("INVALID_INPUT", parsed.error.issues.map((issue) => issue.message).join("; "));
  const who = actorId(actor);
  const image = await validateOriginalImage(parsed.data.base64Data);
  const input = parsed.data;
  const hash = requestHash("upload", { projectId: input.projectId, scriptId: input.scriptId, sha256: image.sha256, mime: image.mime });
  return inProject(db, input.projectId, async (trx) => {
    await assertEpisode(trx, input.projectId, input.scriptId);
    const replay = await readReceipt<any>(trx, who, input.projectId, input.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    const existing = await trx(MEDIA).where({ projectId: input.projectId, scriptId: input.scriptId, sha256: image.sha256 }).first();
    const filePath = existing?.filePath ?? `/${input.projectId}/imageFlow/${input.scriptId}/uploads/${image.sha256}.${image.ext}`;
    if (!existing) {
      await storage.write(filePath, image.data);
      await trx(MEDIA).insert({ filePath, projectId: input.projectId, scriptId: input.scriptId, kind: "image", mime: image.mime, sha256: image.sha256, byteSize: image.data.length, createdBy: who, createdAt: Date.now() });
    }
    const result = { filePath, sha256: image.sha256, mime: image.mime, byteSize: image.data.length, replayed: false };
    await saveReceipt(trx, who, input.projectId, input.idempotencyKey, hash, result);
    return result;
  });
}

async function normalizeDocument(db: Knex | Knex.Transaction, projectId: number, raw: unknown): Promise<ImageFlowDocument> {
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) throw new ImageFlowWorkspaceError("INVALID_INPUT", parsed.error.issues.map((issue) => issue.message).join("; "));
  const nodeIds = parsed.data.nodes.map((node) => node.id);
  if (new Set(nodeIds).size !== nodeIds.length) throw new ImageFlowWorkspaceError("INVALID_INPUT", "节点 ID 不能重复");
  const nodeSet = new Set(nodeIds);
  const edgeIds = parsed.data.edges.map((edge) => edge.id);
  if (new Set(edgeIds).size !== edgeIds.length) throw new ImageFlowWorkspaceError("INVALID_INPUT", "连线 ID 不能重复");
  if (parsed.data.edges.some((edge) => edge.source === edge.target || !nodeSet.has(edge.source) || !nodeSet.has(edge.target))) {
    throw new ImageFlowWorkspaceError("INVALID_INPUT", "连线引用了不存在或相同的节点");
  }
  const values = new Set<string>();
  for (const node of parsed.data.nodes) {
    if (node.type === "upload") { if (node.data.image) values.add(node.data.image); }
    else {
      if (node.data.generatedImage) values.add(node.data.generatedImage);
      for (const reference of node.data.references) if (reference.image) values.add(reference.image);
    }
  }
  const canonical = new Map<string, string>();
  try {
    await Promise.all([...values].map(async (value) => canonical.set(value, await assertImageMediaProject(db, projectId, value))));
  } catch (error) { translate(error); }
  return {
    nodes: parsed.data.nodes.map((node) => node.type === "upload"
      ? { ...node, data: { image: node.data.image ? canonical.get(node.data.image)! : "" } }
      : { ...node, data: {
        ...node.data,
        generatedImage: node.data.generatedImage ? canonical.get(node.data.generatedImage)! : "",
        references: node.data.references.map((reference) => ({ image: reference.image ? canonical.get(reference.image)! : "" })),
      } }),
    edges: parsed.data.edges,
  };
}

async function boundFlowOwner(db: Knex | Knex.Transaction, flowId: number): Promise<ImageFlowOwner | null> {
  const assets = await db("o_assets").where({ flowId }).select("id", "projectId", "scriptId");
  const storyboards = await db("o_storyboard").where({ flowId }).select("projectId", "scriptId");
  const candidates: ImageFlowOwner[] = [];
  for (const row of storyboards) {
    if (!Number.isSafeInteger(Number(row.projectId)) || !Number.isSafeInteger(Number(row.scriptId)) || Number(row.projectId) <= 0 || Number(row.scriptId) <= 0) {
      throw new ImageFlowWorkspaceError("AMBIGUOUS_OWNER", "旧图片工作流缺少可验证的分镜归属");
    }
    candidates.push({ flowId, projectId: Number(row.projectId), scriptId: Number(row.scriptId) });
  }
  for (const asset of assets) {
    const projectId = Number(asset.projectId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new ImageFlowWorkspaceError("AMBIGUOUS_OWNER", "旧图片工作流缺少可验证的素材项目归属");
    const scriptIds = new Set<number>();
    if (Number.isSafeInteger(Number(asset.scriptId)) && Number(asset.scriptId) > 0) scriptIds.add(Number(asset.scriptId));
    const links = await db("o_scriptAssets as link").join("o_script as script", "script.id", "=", "link.scriptId")
      .where("link.assetId", asset.id).where("script.projectId", projectId).select("script.id");
    for (const link of links) scriptIds.add(Number(link.id));
    if (scriptIds.size !== 1) throw new ImageFlowWorkspaceError("AMBIGUOUS_OWNER", "旧图片工作流未唯一绑定剧集");
    candidates.push({ flowId, projectId, scriptId: [...scriptIds][0] });
  }
  const unique = [...new Map(candidates.map((candidate) => [`${candidate.projectId}:${candidate.scriptId}`, candidate])).values()];
  if (!unique.length) return null;
  if (unique.length !== 1) throw new ImageFlowWorkspaceError("AMBIGUOUS_OWNER", "图片工作流关联了多个项目或剧集");
  const owner = unique[0];
  await assertEpisode(db, owner.projectId, owner.scriptId);
  return owner;
}

async function readOwner(db: Knex | Knex.Transaction, flowId: number, lock = false): Promise<ImageFlowOwner> {
  const flowQuery = db("o_imageFlow").where({ id: flowId });
  const flow = lock && (db as Knex.Transaction).isTransaction ? await flowQuery.forUpdate().first() : await flowQuery.first();
  if (!flow) throw new ImageFlowWorkspaceError("NOT_FOUND", "图片工作流不存在");
  const bound = await boundFlowOwner(db, flowId);
  const hasOwners = await db.schema.hasTable(OWNERS);
  const row = hasOwners ? await db(OWNERS).where({ flowId }).first() : undefined;
  if (!row) {
    if (!bound) throw new ImageFlowWorkspaceError("AMBIGUOUS_OWNER", "图片工作流没有真实资源归属");
    return bound;
  }
  const owner = { flowId, projectId: Number(row.projectId), scriptId: Number(row.scriptId) };
  await assertEpisode(db, owner.projectId, owner.scriptId);
  if (bound && (bound.projectId !== owner.projectId || bound.scriptId !== owner.scriptId)) {
    throw new ImageFlowWorkspaceError("AMBIGUOUS_OWNER", "图片工作流登记归属与资产或分镜绑定冲突");
  }
  if (await db.schema.hasTable("ext_creative_state")) {
    const state = await db("ext_creative_state").where({ entityType: "imageFlow", entityId: flowId }).first();
    if (state && Number(state.projectId) !== owner.projectId) throw new ImageFlowWorkspaceError("AMBIGUOUS_OWNER", "图片工作流版本归属冲突");
  }
  return owner;
}

async function resolveOwnerInTransaction(trx: Knex.Transaction, flowId: number): Promise<ImageFlowOwner> {
  if (!(await trx("o_imageFlow").where({ id: flowId }).forUpdate().first())) throw new ImageFlowWorkspaceError("NOT_FOUND", "图片工作流不存在");
  const row = await trx(OWNERS).where({ flowId }).first();
  const owner = await readOwner(trx, flowId);
  if (!row) {
    await trx(OWNERS).insert({ ...owner, createdBy: "system:legacy-image-flow", createdAt: Date.now() });
    const state = await trx("ext_creative_state").where({ entityType: "imageFlow", entityId: flowId }).first();
    if (!state) await trx("ext_creative_state").insert({ entityType: "imageFlow", entityId: flowId, projectId: owner.projectId, version: 0, updatedBy: "system:legacy-image-flow", updatedAt: Date.now() });
  }
  return owner;
}

/** Pure ownership lookup for authorization and runtime use. It performs no DDL or legacy backfill. */
export async function resolveImageFlowOwner(db: Knex | Knex.Transaction, flowIdInput: unknown): Promise<ImageFlowOwner> {
  const parsed = positiveId.safeParse(flowIdInput);
  if (!parsed.success) throw new ImageFlowWorkspaceError("INVALID_INPUT", "flowId 无效");
  return readOwner(db, parsed.data);
}

async function assertFlowScope(trx: Knex.Transaction, input: { flowId: number; projectId: number; scriptId: number }): Promise<void> {
  const owner = await resolveOwnerInTransaction(trx, input.flowId);
  if (owner.projectId !== input.projectId || owner.scriptId !== input.scriptId) throw new ImageFlowWorkspaceError("PROJECT_MISMATCH", "图片工作流不属于当前项目和剧集");
}

async function flowVersion(db: Knex | Knex.Transaction, flowId: number, projectId: number): Promise<number> {
  if (!(await db.schema.hasTable("ext_creative_state"))) return 0;
  try { return (await getCreativeState(db as Knex, "imageFlow", flowId, projectId)).version; }
  catch (error) { translate(error); }
}

export async function createImageFlow(db: Knex, raw: unknown, actor: TrustedActor) {
  await ensureImageFlowWorkspaceSchema(db);
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) throw new ImageFlowWorkspaceError("INVALID_INPUT", parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;
  const who = actorId(actor);
  return inProject(db, input.projectId, async (trx) => {
    await assertEpisode(trx, input.projectId, input.scriptId);
    const document = await normalizeDocument(trx, input.projectId, { nodes: input.nodes, edges: input.edges });
    const hash = requestHash("create", { projectId: input.projectId, scriptId: input.scriptId, expectedVersion: 0, ...document });
    const replay = await readReceipt<any>(trx, who, input.projectId, input.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    const [flowId] = await insertRowsReturningIds(trx, "o_imageFlow", { flowData: JSON.stringify(document) });
    await trx(OWNERS).insert({ flowId, projectId: input.projectId, scriptId: input.scriptId, createdBy: who, createdAt: Date.now() });
    let version: number;
    try { version = (await advanceCreativeState(trx, { entityType: "imageFlow", entityId: flowId, projectId: input.projectId, expectedVersion: 0, actor })).version; }
    catch (error) { translate(error); }
    const result = { id: Number(flowId), flowId: Number(flowId), projectId: input.projectId, scriptId: input.scriptId, version, replayed: false };
    await saveReceipt(trx, who, input.projectId, input.idempotencyKey, hash, result);
    return result;
  });
}

export async function updateImageFlow(db: Knex, raw: unknown, actor: TrustedActor) {
  await ensureImageFlowWorkspaceSchema(db);
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) throw new ImageFlowWorkspaceError("INVALID_INPUT", parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;
  const who = actorId(actor);
  return inProject(db, input.projectId, async (trx) => {
    await assertEpisode(trx, input.projectId, input.scriptId);
    await assertFlowScope(trx, input);
    const document = await normalizeDocument(trx, input.projectId, { nodes: input.nodes, edges: input.edges });
    const hash = requestHash("update", { flowId: input.flowId, projectId: input.projectId, scriptId: input.scriptId, expectedVersion: input.expectedVersion, ...document });
    const replay = await readReceipt<any>(trx, who, input.projectId, input.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    if (await flowVersion(trx, input.flowId, input.projectId) !== input.expectedVersion) throw new ImageFlowWorkspaceError("VERSION_CONFLICT", "图片工作流已被修改，请重新载入");
    let version: number;
    try { version = (await advanceCreativeState(trx, { entityType: "imageFlow", entityId: input.flowId, projectId: input.projectId, expectedVersion: input.expectedVersion, actor })).version; }
    catch (error) { translate(error); }
    await trx("o_imageFlow").where({ id: input.flowId }).update({ flowData: JSON.stringify(document) });
    const result = { id: input.flowId, flowId: input.flowId, projectId: input.projectId, scriptId: input.scriptId, version, replayed: false };
    await saveReceipt(trx, who, input.projectId, input.idempotencyKey, hash, result);
    return result;
  });
}

export async function readImageFlow(db: Knex, raw: { id?: unknown; flowId?: unknown; projectId?: unknown; scriptId?: unknown }): Promise<ImageFlowView> {
  const scope = z.object({ id: positiveId, projectId: positiveId, scriptId: positiveId }).strict().safeParse({ id: raw?.id ?? raw?.flowId, projectId: raw?.projectId, scriptId: raw?.scriptId });
  if (!scope.success) throw new ImageFlowWorkspaceError("INVALID_INPUT", scope.error.issues.map((issue) => issue.message).join("; "));
  return inProject(db, scope.data.projectId, async (trx) => {
    await assertEpisode(trx, scope.data.projectId, scope.data.scriptId);
    const owner = await readOwner(trx, scope.data.id);
    if (owner.projectId !== scope.data.projectId || owner.scriptId !== scope.data.scriptId) throw new ImageFlowWorkspaceError("PROJECT_MISMATCH", "图片工作流不属于当前项目和剧集");
    const row = await trx("o_imageFlow").where({ id: scope.data.id }).first();
    let rawDocument: unknown;
    try { rawDocument = JSON.parse(row.flowData); }
    catch { throw new ImageFlowWorkspaceError("INVALID_INPUT", "图片工作流数据损坏"); }
    const document = await normalizeDocument(trx, scope.data.projectId, rawDocument);
    return { id: scope.data.id, flowId: scope.data.id, projectId: scope.data.projectId, scriptId: scope.data.scriptId, version: await flowVersion(trx, scope.data.id, scope.data.projectId), ...document };
  });
}

export async function presentImageFlow(view: ImageFlowView, url: (path: string) => Promise<string>): Promise<ImageFlowView> {
  return {
    ...view,
    nodes: await Promise.all(view.nodes.map(async (node) => node.type === "upload"
      ? { ...node, data: { image: node.data.image ? await url(node.data.image) : "" } }
      : { ...node, data: {
        ...node.data,
        generatedImage: node.data.generatedImage ? await url(node.data.generatedImage) : "",
        references: await Promise.all(node.data.references.map(async (reference) => ({ image: reference.image ? await url(reference.image) : "" }))),
      } })),
  };
}
