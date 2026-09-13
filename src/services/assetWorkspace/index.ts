import { createHash } from "node:crypto";
import type { Knex } from "knex";
import sharp from "sharp";
import { lockProjectTransaction } from "../../lib/dbTransaction";
import { insertRowsReturningIds } from "../../lib/insertRows";
import {
  advanceCreativeState,
  CreativeWorkspaceError,
  ensureCreativeWorkspaceSchema,
  getCreativeState,
} from "../creativeWorkspace";
import { ensureProductionStateSchema } from "../productionState";
import type { TrustedActor } from "../productionState";

const RECEIPTS = "ext_asset_mutations";

export interface AssetStorage {
  write(path: string, data: Buffer): Promise<void>;
  delete(path: string): Promise<void>;
  url(path: string, image: boolean): Promise<string>;
}

export class AssetWorkspaceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "PROJECT_MISMATCH"
      | "VERSION_CONFLICT"
      | "IDEMPOTENCY_CONFLICT"
      | "REFERENCED"
      | "LOCKED",
    message: string,
  ) {
    super(message);
    this.name = "AssetWorkspaceError";
  }
}

interface ValidatedMedia {
  mime: string;
  data: Buffer;
  ext: string;
  image: boolean;
}

interface PreparedAudioItem {
  raw: any;
  path?: string;
  media?: ValidatedMedia;
}

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([name]) => name !== "idempotencyKey" && name !== "mutationKey")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, item]) => [name, stableValue(item)]),
    );
  }
  return value;
}

const requestHash = (value: unknown): string => digest(JSON.stringify(stableValue(value)));

function actorId(actor: TrustedActor): string {
  if (!actor?.id || !["human", "agent", "system"].includes(actor.kind)) {
    throw new AssetWorkspaceError("INVALID_INPUT", "缺少可信操作身份");
  }
  return actor.id;
}

function positive(value: unknown, field = "ID"): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new AssetWorkspaceError("INVALID_INPUT", `${field} 无效`);
  return parsed;
}

function expectedVersion(value: unknown, field = "expectedVersion"): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AssetWorkspaceError("INVALID_INPUT", `${field} 无效`);
  return parsed;
}

function mutationKey(raw: any): string {
  const idempotencyKey = raw?.idempotencyKey;
  const legacyKey = raw?.mutationKey;
  if (idempotencyKey && legacyKey && idempotencyKey !== legacyKey) {
    throw new AssetWorkspaceError("IDEMPOTENCY_CONFLICT", "操作编号冲突");
  }
  const value = idempotencyKey ?? legacyKey;
  if (typeof value !== "string" || !/^[\w:.-]{8,150}$/.test(value)) {
    throw new AssetWorkspaceError("INVALID_INPUT", "缺少有效操作编号");
  }
  return value;
}

function translateWorkspaceError(error: unknown): never {
  if (error instanceof CreativeWorkspaceError) throw new AssetWorkspaceError(error.code, error.message);
  throw error;
}

async function advanceAssetState(
  trx: Knex.Transaction,
  input: { entityId: number; projectId: number; expectedVersion: number; actor: TrustedActor },
): Promise<void> {
  try {
    await advanceCreativeState(trx, { entityType: "asset", ...input });
  } catch (error) {
    translateWorkspaceError(error);
  }
}

async function readReceipt<T>(
  db: Knex | Knex.Transaction,
  who: string,
  projectId: number,
  key: string,
  hash: string,
): Promise<T | undefined> {
  const row = await db(RECEIPTS).where({ actorId: who, projectId, idempotencyKey: key }).first();
  if (!row) return undefined;
  if (row.requestHash !== hash) throw new AssetWorkspaceError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同内容");
  return JSON.parse(row.result) as T;
}

async function saveReceipt(
  trx: Knex.Transaction,
  who: string,
  projectId: number,
  key: string,
  hash: string,
  result: unknown,
): Promise<void> {
  await trx(RECEIPTS).insert({ actorId: who, projectId, idempotencyKey: key, requestHash: hash, result: JSON.stringify(result), createdAt: Date.now() });
}

export async function ensureAssetWorkspaceSchema(db: Knex): Promise<void> {
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

function parseDataUrl(value: unknown): { mime: string; data: Buffer } {
  if (typeof value !== "string") throw new AssetWorkspaceError("INVALID_INPUT", "文件数据无效");
  const match = value.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) throw new AssetWorkspaceError("INVALID_INPUT", "文件必须是完整 base64 Data URL");
  const data = Buffer.from(match[2], "base64");
  if (!data.length || data.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) {
    throw new AssetWorkspaceError("INVALID_INPUT", "base64 数据损坏");
  }
  return { mime: match[1].toLowerCase(), data };
}

export async function validateMedia(value: unknown): Promise<ValidatedMedia> {
  const parsed = parseDataUrl(value);
  const { data, mime } = parsed;
  if (mime.startsWith("image/")) {
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(data).metadata();
    } catch {
      throw new AssetWorkspaceError("INVALID_INPUT", "图片无法解码");
    }
    if (!metadata.format || !metadata.width || !metadata.height) throw new AssetWorkspaceError("INVALID_INPUT", "图片无法解码");
    return { ...parsed, ext: metadata.format === "jpeg" ? "jpg" : metadata.format, image: true };
  }
  const isFtyp = (buffer: Buffer) => buffer.length >= 12 && buffer.subarray(4, 8).toString() === "ftyp";
  const checks: Record<string, [string, (buffer: Buffer) => boolean]> = {
    "audio/mpeg": ["mp3", (buffer) => buffer.subarray(0, 3).toString() === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)],
    "audio/mp3": ["mp3", (buffer) => buffer.subarray(0, 3).toString() === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)],
    "audio/wav": ["wav", (buffer) => buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WAVE"],
    "audio/x-wav": ["wav", (buffer) => buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WAVE"],
    "audio/flac": ["flac", (buffer) => buffer.subarray(0, 4).toString() === "fLaC"],
    "audio/x-flac": ["flac", (buffer) => buffer.subarray(0, 4).toString() === "fLaC"],
    "audio/ogg": ["ogg", (buffer) => buffer.subarray(0, 4).toString() === "OggS"],
    "audio/mp4": ["m4a", isFtyp],
    "audio/x-m4a": ["m4a", isFtyp],
    "audio/aiff": ["aiff", (buffer) => buffer.subarray(0, 4).toString() === "FORM" && ["AIFF", "AIFC"].includes(buffer.subarray(8, 12).toString())],
    "audio/x-aiff": ["aiff", (buffer) => buffer.subarray(0, 4).toString() === "FORM" && ["AIFF", "AIFC"].includes(buffer.subarray(8, 12).toString())],
    "video/mp4": ["mp4", isFtyp],
    "video/webm": ["webm", (buffer) => buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))],
  };
  const check = checks[mime];
  if (!check || !check[1](data)) throw new AssetWorkspaceError("INVALID_INPUT", "媒体签名与类型不匹配");
  return { ...parsed, ext: check[0], image: false };
}

async function assertProject(db: Knex | Knex.Transaction, projectId: number): Promise<void> {
  if (!(await db("o_project").where({ id: projectId }).first())) throw new AssetWorkspaceError("NOT_FOUND", "项目不存在");
}

async function assetRow(db: Knex | Knex.Transaction, id: number, projectId?: number): Promise<any> {
  const row = await db("o_assets").where({ id, ...(projectId === undefined ? {} : { projectId }) }).first();
  if (!row) throw new AssetWorkspaceError(projectId === undefined ? "NOT_FOUND" : "PROJECT_MISMATCH", "资产不存在或不属于项目");
  return row;
}

async function assetView(db: Knex | Knex.Transaction, id: number): Promise<any> {
  const row = await assetRow(db, id);
  return { ...row, id: Number(row.id), projectId: Number(row.projectId), version: (await getCreativeState(db as Knex, "asset", Number(row.id), Number(row.projectId))).version };
}

async function assertNoLockedStoryboardReference(trx: Knex.Transaction, assetIds: number[]): Promise<void> {
  if (!assetIds.length) return;
  const linked = await trx("o_assets2Storyboard as link")
    .join("ext_entity_state as state", function joinState() {
      this.on("state.entityType", "=", trx.raw("?", ["storyboard"]))
        .andOn("state.entityId", "=", "link.storyboardId")
        .andOn("state.locked", "=", trx.raw("?", [1]));
    })
    .whereIn("link.assetId", assetIds)
    .first();
  if (linked) throw new AssetWorkspaceError("LOCKED", "锁定分镜引用了该资产，不能修改或删除");
}

async function assertNoStoryboardReference(trx: Knex.Transaction, assetIds: number[]): Promise<void> {
  await assertNoLockedStoryboardReference(trx, assetIds);
  if (assetIds.length && (await trx("o_assets2Storyboard").whereIn("assetId", assetIds).first())) {
    throw new AssetWorkspaceError("REFERENCED", "资产已被分镜引用");
  }
}

function deterministicPath(projectId: number, area: string, key: string, hash: string, ext: string): string {
  return `/${projectId}/${area}/${digest(`${key}:${hash}`).slice(0, 40)}.${ext}`;
}

function mediaRequest(raw: any, media: ValidatedMedia, field: "base64" | "base64Data"): any {
  return { ...raw, [field]: undefined, contentHash: digest(media.data), contentMime: media.mime };
}

async function cleanupStaged(storage: AssetStorage, paths: readonly string[]): Promise<void> {
  await Promise.all([...new Set(paths)].map((path) => storage.delete(path).catch(() => undefined)));
}

export async function createAsset(db: Knex, raw: any, actor: TrustedActor): Promise<any> {
  const projectId = positive(raw.projectId, "projectId");
  const key = mutationKey(raw);
  const who = actorId(actor);
  const hash = requestHash(raw);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    const replay = await readReceipt<any>(trx, who, projectId, key, hash);
    if (replay) return { ...replay, reused: true };
    await assertProject(trx, projectId);
    const [id] = await insertRowsReturningIds(trx, "o_assets", { projectId, name: String(raw.name ?? ""), describe: String(raw.describe ?? ""), type: String(raw.type ?? ""), remark: raw.remark ?? null, prompt: raw.prompt ?? null, startTime: Date.now() });
    await advanceAssetState(trx, { entityId: id, projectId, expectedVersion: 0, actor });
    const result = { assetId: id, asset: await assetView(trx, id) };
    await saveReceipt(trx, who, projectId, key, hash, result);
    return { ...result, reused: false };
  });
}

export async function updateAsset(db: Knex, raw: any, actor: TrustedActor): Promise<any> {
  const id = positive(raw.id);
  const projectId = positive(raw.projectId, "projectId");
  const expected = expectedVersion(raw.expectedVersion);
  const key = mutationKey(raw);
  const who = actorId(actor);
  const hash = requestHash(raw);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    const replay = await readReceipt<any>(trx, who, projectId, key, hash);
    if (replay) return { ...replay, reused: true };
    await assetRow(trx, id, projectId);
    await assertNoLockedStoryboardReference(trx, [id]);
    await advanceAssetState(trx, { entityId: id, projectId, expectedVersion: expected, actor });
    const patch: Record<string, unknown> = { name: String(raw.name ?? ""), describe: String(raw.describe ?? "") };
    for (const field of ["remark", "prompt"] as const) if (raw[field] !== undefined) patch[field] = raw[field];
    await trx("o_assets").where({ id, projectId }).update(patch);
    const result = { asset: await assetView(trx, id) };
    await saveReceipt(trx, who, projectId, key, hash, result);
    return { ...result, reused: false };
  });
}

export async function uploadAsset(db: Knex, raw: any, actor: TrustedActor, storage: AssetStorage): Promise<any> {
  const projectId = positive(raw.projectId, "projectId");
  const key = mutationKey(raw);
  const who = actorId(actor);
  await assertProject(db, projectId);
  const field: "base64" | "base64Data" = raw.base64Data === undefined ? "base64" : "base64Data";
  const media = await validateMedia(raw[field]);
  const canonical = mediaRequest(raw, media, field);
  const hash = requestHash(canonical);
  const replay = await readReceipt<any>(db, who, projectId, key, hash);
  if (replay) return { ...replay, reused: true };
  const path = deterministicPath(projectId, "assets", key, hash, media.ext);
  await storage.write(path, media.data);
  try {
    return await db.transaction(async (trx) => {
      await lockProjectTransaction(trx, projectId);
      const old = await readReceipt<any>(trx, who, projectId, key, hash);
      if (old) return { ...old, reused: true };
      await assertProject(trx, projectId);
      const [assetId] = await insertRowsReturningIds(trx, "o_assets", { projectId, type: String(raw.type ?? (media.image ? "clip" : "audio")), name: String(raw.name ?? ""), describe: raw.describe ?? null, startTime: Date.now() });
      const [imageId] = await insertRowsReturningIds(trx, "o_image", { assetsId: assetId, filePath: path, type: String(raw.type ?? "clip"), state: "已完成" });
      await trx("o_assets").where({ id: assetId, projectId }).update({ imageId });
      await advanceAssetState(trx, { entityId: assetId, projectId, expectedVersion: 0, actor });
      const result = { assetId, imageId, asset: await assetView(trx, assetId) };
      await saveReceipt(trx, who, projectId, key, hash, result);
      return { ...result, reused: false };
    });
  } catch (error) {
    await cleanupStaged(storage, [path]);
    throw error;
  }
}

export async function selectAssetImage(db: Knex, raw: any, actor: TrustedActor, storage: AssetStorage): Promise<any> {
  const assetId = positive(raw.id);
  const projectId = positive(raw.projectId, "projectId");
  const expected = expectedVersion(raw.expectedVersion);
  const key = mutationKey(raw);
  const who = actorId(actor);
  let media: ValidatedMedia | undefined;
  let canonical = raw;
  if (raw.base64) {
    media = await validateMedia(raw.base64);
    if (!media.image) throw new AssetWorkspaceError("INVALID_INPUT", "只允许图片");
    canonical = mediaRequest(raw, media, "base64");
  }
  const hash = requestHash(canonical);
  const replay = await readReceipt<any>(db, who, projectId, key, hash);
  if (replay) return { ...replay, reused: true };
  const staged = media ? deterministicPath(projectId, String(raw.type || "assets"), key, hash, media.ext) : undefined;
  if (staged && media) await storage.write(staged, media.data);
  try {
    return await db.transaction(async (trx) => {
      await lockProjectTransaction(trx, projectId);
      const old = await readReceipt<any>(trx, who, projectId, key, hash);
      if (old) return { ...old, reused: true };
      const asset = await assetRow(trx, assetId, projectId);
      await assertNoLockedStoryboardReference(trx, [assetId]);
      let imageId = raw.imageId == null ? undefined : positive(raw.imageId, "imageId");
      if (staged) {
        [imageId] = await insertRowsReturningIds(trx, "o_image", { assetsId: assetId, filePath: staged, type: String(raw.type ?? asset.type ?? ""), state: "已完成" });
      } else {
        const candidate = imageId && await trx("o_image").where({ id: imageId, assetsId: assetId, state: "已完成" }).first();
        if (!candidate) throw new AssetWorkspaceError("PROJECT_MISMATCH", "候选图片不属于该资产或尚未完成");
      }
      await advanceAssetState(trx, { entityId: assetId, projectId, expectedVersion: expected, actor });
      await trx("o_assets").where({ id: assetId, projectId }).update({ imageId, ...(raw.prompt === undefined ? {} : { prompt: raw.prompt }) });
      const result = { assetId, imageId, version: expected + 1 };
      await saveReceipt(trx, who, projectId, key, hash, result);
      return { ...result, reused: false };
    });
  } catch (error) {
    if (staged) await cleanupStaged(storage, [staged]);
    throw error;
  }
}

function presentAsset(row: any, version: number): any {
  const result = { ...row, id: Number(row.id), projectId: Number(row.projectId), version };
  if (row.type === "audio" && row.assetsId == null) {
    const [sex = "", ...description] = String(row.describe ?? "").split("|");
    result.sex = sex;
    result.describe = description.join("|");
  }
  return result;
}

export async function listAssets(db: Knex, projectIdInput: number, type: string, name?: string, page = 1, limit = 10): Promise<any> {
  const projectId = positive(projectIdInput, "projectId");
  if (!Number.isSafeInteger(page) || page <= 0 || !Number.isSafeInteger(limit) || limit <= 0 || limit > 500) throw new AssetWorkspaceError("INVALID_INPUT", "分页参数无效");
  await assertProject(db, projectId);
  let query = db("o_assets").leftJoin("o_image", "o_assets.imageId", "o_image.id").where("o_assets.projectId", projectId).where("o_assets.type", type).whereNull("o_assets.assetsId").select("o_assets.*", "o_image.filePath", "o_image.state");
  if (name) query = query.where("o_assets.name", "like", `%${name}%`);
  const parents = await query.orderBy("o_assets.id").offset((page - 1) * limit).limit(limit);
  const parentIds = parents.map((row: any) => Number(row.id));
  const children = parentIds.length ? await db("o_assets").leftJoin("o_image", "o_assets.imageId", "o_image.id").whereIn("o_assets.assetsId", parentIds).where("o_assets.projectId", projectId).select("o_assets.*", "o_image.filePath", "o_image.state", "o_image.errorReason").orderBy("o_assets.id") : [];
  const entityIds = [...parentIds, ...children.map((row: any) => Number(row.id))];
  const states = entityIds.length ? await db("ext_creative_state").where({ entityType: "asset", projectId }).whereIn("entityId", entityIds) : [];
  const versions = new Map(states.map((row: any) => [Number(row.entityId), Number(row.version)]));
  let totalQuery = db("o_assets").where({ projectId, type }).whereNull("assetsId");
  if (name) totalQuery = totalQuery.where("name", "like", `%${name}%`);
  const total = await totalQuery.count("id as count").first();
  return {
    data: parents.map((parent: any) => ({ ...presentAsset(parent, versions.get(Number(parent.id)) ?? 0), sonAssets: children.filter((child: any) => Number(child.assetsId) === Number(parent.id)).map((child: any) => presentAsset(child, versions.get(Number(child.id)) ?? 0)) })),
    total: Number(total?.count ?? 0),
  };
}

export async function getImages(db: Knex, assetIdInput: number): Promise<any> {
  const assetId = positive(assetIdInput, "assetsId");
  const asset = await assetRow(db, assetId);
  const images = await db("o_image").where({ assetsId: assetId }).select("id", "filePath", "assetsId", "type", "state");
  return { id: Number(asset.id), imageId: asset.imageId ?? null, version: (await getCreativeState(db, "asset", Number(asset.id), Number(asset.projectId))).version, tempAssets: images.map((image: any) => ({ ...image, selected: asset.imageId != null && Number(image.id) === Number(asset.imageId) })) };
}

export async function deleteImage(db: Knex, raw: any, actor: TrustedActor, storage: AssetStorage): Promise<any> {
  const imageId = positive(raw.id);
  const projectId = positive(raw.projectId, "projectId");
  const key = mutationKey(raw);
  const who = actorId(actor);
  const hash = requestHash(raw);
  const replay = await readReceipt<any>(db, who, projectId, key, hash);
  if (replay) return { ...replay, reused: true };
  const image = await db("o_image").where({ id: imageId }).first();
  if (!image) throw new AssetWorkspaceError("NOT_FOUND", "图片不存在");
  const asset = await assetRow(db, Number(image.assetsId), projectId);
  const result = await db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    const replay = await readReceipt<any>(trx, who, projectId, key, hash);
    if (replay) return { ...replay, reused: true };
    const current = await assetRow(trx, Number(asset.id), projectId);
    if (Number(current.imageId) === imageId) throw new AssetWorkspaceError("REFERENCED", "当前选中图片不能删除");
    const owned = await trx("o_image").where({ id: imageId, assetsId: asset.id }).first();
    if (!owned) throw new AssetWorkspaceError("PROJECT_MISMATCH", "图片不属于该资产");
    await trx("o_image").where({ id: imageId, assetsId: asset.id }).delete();
    const output = { imageId };
    await saveReceipt(trx, who, projectId, key, hash, output);
    return { ...output, reused: false };
  });
  if (!result.reused && image.filePath) await storage.delete(image.filePath).catch(() => undefined);
  return result;
}

async function collectDeletionTree(trx: Knex.Transaction, roots: number[], projectId: number): Promise<{ rows: any[]; ids: number[] }> {
  const rows = await trx("o_assets").where({ projectId }).where((builder) => builder.whereIn("id", roots).orWhereIn("assetsId", roots));
  if (roots.some((id) => !rows.some((row: any) => Number(row.id) === id))) throw new AssetWorkspaceError("PROJECT_MISMATCH", "资产不存在或不属于项目");
  const rootSet = new Set(roots);
  for (const row of rows) {
    if (row.assetsId != null && rootSet.has(Number(row.id))) {
      const parent = await trx("o_assets").where({ id: row.assetsId, projectId }).first();
      if (!parent) throw new AssetWorkspaceError("PROJECT_MISMATCH", "子资产的父资产不属于当前项目");
    }
  }
  return { rows, ids: [...new Set(rows.map((row: any) => Number(row.id)))] };
}

async function deleteRows(trx: Knex.Transaction, ids: number[]): Promise<string[]> {
  const images = await trx("o_image").whereIn("assetsId", ids);
  const paths = images.map((row: any) => row.filePath).filter((path: unknown): path is string => typeof path === "string" && Boolean(path));
  await trx("o_assetsRole2Audio").whereIn("assetsRoleId", ids).orWhereIn("assetsAudioId", ids).delete();
  await trx("o_scriptAssets").whereIn("assetId", ids).delete();
  await trx("o_assets").whereIn("id", ids).update({ imageId: null });
  await trx("o_image").whereIn("assetsId", ids).delete();
  await trx("o_assets").whereIn("id", ids).delete();
  await trx("ext_creative_state").where({ entityType: "asset" }).whereIn("entityId", ids).delete();
  return paths;
}

export async function batchDeleteAssets(db: Knex, raw: any, actor: TrustedActor, storage: AssetStorage): Promise<any> {
  const projectId = positive(raw.projectId, "projectId");
  const rawIds = raw.ids ?? raw.id;
  if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 1000) throw new AssetWorkspaceError("INVALID_INPUT", "资产列表无效");
  const ids = [...new Set(rawIds.map((id: unknown) => positive(id)))];
  if (!raw.expectedVersions || typeof raw.expectedVersions !== "object") throw new AssetWorkspaceError("INVALID_INPUT", "缺少资产版本");
  const key = mutationKey(raw);
  const who = actorId(actor);
  const hash = requestHash({ ...raw, ids, id: undefined });
  const paths: string[] = [];
  const result = await db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    const replay = await readReceipt<any>(trx, who, projectId, key, hash);
    if (replay) return { ...replay, reused: true };
    await assertProject(trx, projectId);
    const tree = await collectDeletionTree(trx, ids, projectId);
    await assertNoStoryboardReference(trx, tree.ids);
    for (const id of ids) await advanceAssetState(trx, { entityId: id, projectId, expectedVersion: expectedVersion(raw.expectedVersions[id], `expectedVersions.${id}`), actor });
    paths.push(...await deleteRows(trx, tree.ids));
    const output = { assetIds: ids, deleted: ids.map((assetId) => ({ assetId })) };
    await saveReceipt(trx, who, projectId, key, hash, output);
    return { ...output, reused: false };
  });
  if (!result.reused) await cleanupStaged(storage, paths);
  return result;
}

export async function deleteAsset(db: Knex, raw: any, actor: TrustedActor, storage: AssetStorage): Promise<any> {
  const result = await batchDeleteAssets(db, { ...raw, ids: [raw.id], id: undefined, expectedVersions: { [String(raw.id)]: raw.expectedVersion } }, actor, storage);
  return { assetId: result.assetIds[0], reused: result.reused };
}

async function prepareAudioItems(projectId: number, key: string, hash: string, rawItems: any[], requireMediaForNew: boolean): Promise<PreparedAudioItem[]> {
  return Promise.all(rawItems.map(async (item, index) => {
    if (!item || typeof item !== "object") throw new AssetWorkspaceError("INVALID_INPUT", `assetsItem.${index} 无效`);
    if (!item.base64) {
      if (requireMediaForNew && item.id == null) throw new AssetWorkspaceError("INVALID_INPUT", `assetsItem.${index} 缺少音频文件`);
      return { raw: item };
    }
    const media = await validateMedia(item.base64);
    if (media.image || !media.mime.startsWith("audio/")) throw new AssetWorkspaceError("INVALID_INPUT", `assetsItem.${index} 必须是音频`);
    return { raw: item, media, path: deterministicPath(projectId, "assets/audio", `${key}:${index}`, `${hash}:${digest(media.data)}`, media.ext) };
  }));
}

function canonicalAudioRequest(raw: any): any {
  return {
    ...raw,
    assetsItem: raw.assetsItem?.map((item: any) => {
      if (!item.base64) return item;
      const parsed = parseDataUrl(item.base64);
      return { ...item, base64: undefined, contentHash: digest(parsed.data), contentMime: parsed.mime };
    }),
  };
}

async function audioView(db: Knex | Knex.Transaction, parentId: number): Promise<any> {
  const asset = await assetView(db, parentId);
  const children = await db("o_assets").where({ assetsId: parentId, projectId: asset.projectId }).orderBy("id");
  return { asset, children: await Promise.all(children.map((row: any) => assetView(db, Number(row.id)))) };
}

export async function createAudioAsset(db: Knex, raw: any, actor: TrustedActor, storage: AssetStorage): Promise<any> {
  const projectId = positive(raw.projectId, "projectId");
  const key = mutationKey(raw);
  const who = actorId(actor);
  if (!Array.isArray(raw.assetsItem)) throw new AssetWorkspaceError("INVALID_INPUT", "assetsItem 无效");
  if (raw.assetsItem.some((item: any) => item?.id != null || !item?.base64)) {
    throw new AssetWorkspaceError("INVALID_INPUT", "新增音频子项必须提供文件且不能指定已有 ID");
  }
  await assertProject(db, projectId);
  const canonical = canonicalAudioRequest(raw);
  const hash = requestHash(canonical);
  const replay = await readReceipt<any>(db, who, projectId, key, hash);
  if (replay) return { ...replay, reused: true };
  const prepared = await prepareAudioItems(projectId, key, hash, raw.assetsItem, true);
  try {
    for (const item of prepared) if (item.path && item.media) await storage.write(item.path, item.media.data);
    return await db.transaction(async (trx) => {
      await lockProjectTransaction(trx, projectId);
      const old = await readReceipt<any>(trx, who, projectId, key, hash);
      if (old) return { ...old, reused: true };
      await assertProject(trx, projectId);
      const [assetId] = await insertRowsReturningIds(trx, "o_assets", { name: String(raw.name ?? ""), describe: String(raw.describe ?? ""), type: "audio", projectId, startTime: Date.now() });
      await advanceAssetState(trx, { entityId: assetId, projectId, expectedVersion: 0, actor });
      const childIds: number[] = [];
      for (const item of prepared) {
        const [childId] = await insertRowsReturningIds(trx, "o_assets", { prompt: String(item.raw.prompt ?? ""), assetsId: assetId, type: "audio", describe: String(item.raw.describe ?? ""), name: String(item.raw.name ?? ""), projectId, startTime: Date.now() });
        const [imageId] = await insertRowsReturningIds(trx, "o_image", { filePath: item.path, type: "audio", assetsId: childId, state: "已完成" });
        await trx("o_assets").where({ id: childId, projectId }).update({ imageId });
        await advanceAssetState(trx, { entityId: childId, projectId, expectedVersion: 0, actor });
        childIds.push(childId);
      }
      const result = { assetId, childIds, ...(await audioView(trx, assetId)) };
      await saveReceipt(trx, who, projectId, key, hash, result);
      return { ...result, reused: false };
    });
  } catch (error) {
    await cleanupStaged(storage, prepared.flatMap((item) => item.path ? [item.path] : []));
    throw error;
  }
}

function sameStoredPath(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown) => String(value ?? "").replace(/^https?:\/\/[^/]+/i, "").replace(/^\/oss/, "").replace(/^\/+/, "").split("?")[0];
  return normalize(left) === normalize(right);
}

export async function updateAudioAsset(db: Knex, raw: any, actor: TrustedActor, storage: AssetStorage): Promise<any> {
  const parentId = positive(raw.id);
  const projectId = positive(raw.projectId, "projectId");
  const expected = expectedVersion(raw.expectedVersion);
  const key = mutationKey(raw);
  const who = actorId(actor);
  if (raw.assetsItem !== undefined && !Array.isArray(raw.assetsItem)) throw new AssetWorkspaceError("INVALID_INPUT", "assetsItem 无效");
  await assertProject(db, projectId);
  const canonical = canonicalAudioRequest(raw);
  const hash = requestHash(canonical);
  const replay = await readReceipt<any>(db, who, projectId, key, hash);
  if (replay) return { ...replay, reused: true };
  const prepared = await prepareAudioItems(projectId, key, hash, raw.assetsItem ?? [], true);
  const deletedPaths: string[] = [];
  try {
    for (const item of prepared) if (item.path && item.media) await storage.write(item.path, item.media.data);
    const result = await db.transaction(async (trx) => {
      await lockProjectTransaction(trx, projectId);
      const old = await readReceipt<any>(trx, who, projectId, key, hash);
      if (old) return { ...old, reused: true };
      const parent = await assetRow(trx, parentId, projectId);
      if (parent.assetsId != null || parent.type !== "audio") throw new AssetWorkspaceError("PROJECT_MISMATCH", "音频父资产不属于当前项目");
      await assertNoLockedStoryboardReference(trx, [parentId]);
      await advanceAssetState(trx, { entityId: parentId, projectId, expectedVersion: expected, actor });
      await trx("o_assets").where({ id: parentId, projectId }).update({ name: String(raw.name ?? parent.name ?? ""), describe: String(raw.describe ?? parent.describe ?? "") });
      if (raw.assetsItem !== undefined) {
        const existing = await trx("o_assets").where({ assetsId: parentId, projectId }).orderBy("id");
        const existingById = new Map(existing.map((row: any) => [Number(row.id), row]));
        const incomingIds = new Set<number>();
        for (const item of prepared) {
          if (item.raw.id == null) continue;
          const childId = positive(item.raw.id, "assetsItem.id");
          if (incomingIds.has(childId)) throw new AssetWorkspaceError("INVALID_INPUT", "assetsItem 包含重复子资产");
          incomingIds.add(childId);
          const child = existingById.get(childId);
          if (!child) throw new AssetWorkspaceError("PROJECT_MISMATCH", "音频子资产不属于当前项目或父资产");
          const selected = child.imageId == null ? undefined : await trx("o_image").where({ id: child.imageId, assetsId: childId }).first();
          if (!item.media && item.raw.src && (!selected || !sameStoredPath(item.raw.src, selected.filePath))) throw new AssetWorkspaceError("PROJECT_MISMATCH", "音频文件不属于该子资产");
        }
        const removed = existing.filter((row: any) => !incomingIds.has(Number(row.id)));
        await assertNoStoryboardReference(trx, removed.map((row: any) => Number(row.id)));
        await assertNoLockedStoryboardReference(trx, [...incomingIds]);
        for (const item of prepared) {
          if (item.raw.id != null) {
            const childId = positive(item.raw.id, "assetsItem.id");
            await advanceAssetState(trx, { entityId: childId, projectId, expectedVersion: expectedVersion(item.raw.expectedVersion, `assetsItem.${childId}.expectedVersion`), actor });
            const patch: Record<string, unknown> = { prompt: String(item.raw.prompt ?? ""), describe: String(item.raw.describe ?? ""), name: String(item.raw.name ?? "") };
            if (item.path) {
              const [imageId] = await insertRowsReturningIds(trx, "o_image", { filePath: item.path, type: "audio", assetsId: childId, state: "已完成" });
              patch.imageId = imageId;
            }
            await trx("o_assets").where({ id: childId, projectId, assetsId: parentId }).update(patch);
          } else {
            const [childId] = await insertRowsReturningIds(trx, "o_assets", { prompt: String(item.raw.prompt ?? ""), assetsId: parentId, type: "audio", projectId, describe: String(item.raw.describe ?? ""), name: String(item.raw.name ?? ""), startTime: Date.now() });
            const [imageId] = await insertRowsReturningIds(trx, "o_image", { filePath: item.path, type: "audio", assetsId: childId, state: "已完成" });
            await trx("o_assets").where({ id: childId, projectId }).update({ imageId });
            await advanceAssetState(trx, { entityId: childId, projectId, expectedVersion: 0, actor });
          }
        }
        if (removed.length) deletedPaths.push(...await deleteRows(trx, removed.map((row: any) => Number(row.id))));
      }
      const view = await audioView(trx, parentId);
      const output = { assetId: parentId, childIds: view.children.map((child: any) => child.id), ...view };
      await saveReceipt(trx, who, projectId, key, hash, output);
      return { ...output, reused: false };
    });
    if (!result.reused) await cleanupStaged(storage, deletedPaths);
    return result;
  } catch (error) {
    await cleanupStaged(storage, prepared.flatMap((item) => item.path ? [item.path] : []));
    throw error;
  }
}
