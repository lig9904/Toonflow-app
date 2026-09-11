import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { Knex } from "knex";
import sharp from "sharp";
import { z } from "zod";
import { isPostgres, lockProjectTransaction } from "../lib/dbTransaction";
import { issueVideoReferenceLease, issueProjectAssetReferenceLease, resolveBridgeFilePath, type VideoReferenceLeaseOptions } from "./videoReferenceBridge";
import {
  readLocalVolcengineReferenceSource,
  replaceVolcengineReferenceBindings,
  VolcengineTrustedAssetClient,
  VolcengineTrustedAssetError,
  type LocalReferenceTarget,
} from "./volcengineTrustedAssets";

const GROUP_OPERATIONS = "ext_volcengine_group_creations";
const UPLOAD_OPERATIONS = "ext_volcengine_asset_uploads";
const remoteId = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const idempotencyKey = z.string().min(8).max(150).regex(/^[\w:.-]+$/);
const remoteProjectName = z.string().trim().min(1).max(128).default("default");
const sourceHash = z.string().regex(/^[a-f0-9]{64}$/);
const mediaType = z.enum(["Image", "Video", "Audio"]);
const lookup = z.object({ projectId: z.number().int().positive(), operationId: z.string().uuid().optional(), idempotencyKey: idempotencyKey.optional() }).strict().refine((value) => Boolean(value.operationId) !== Boolean(value.idempotencyKey), "operationId 与 idempotencyKey 必须且只能提供一个");
const execFileAsync = promisify(execFile);
const ffprobePath = process.env.TOONFLOW_FFPROBE_PATH || (process.platform === "darwin" ? "/opt/homebrew/bin/ffprobe" : "/usr/bin/ffprobe");

export type GroupCreationStatus = "submission_unknown" | "created" | "rejected";
export type AssetUploadStatus = "submission_unknown" | "processing" | "active" | "failed" | "rejected";
export type AssetUploadBindStatus = "not_requested" | "pending" | "bound" | "conflict" | "failed";
export interface UploadErrorView { code: string; message: string }

export interface VolcengineAssetUploadRuntime {
  prepareSource(input: UploadStartInput): Promise<PreparedUploadSource>;
  hashSource(filePath: string): Promise<string>;
}
export interface PreparedUploadSource {
  sourceVersion: number;
  sourceFilePath: string;
  sourceFileHash: string;
  mediaType: "Image" | "Video" | "Audio";
  leaseUrl: string;
  leaseId: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
  expiresAt: number;
}
export interface UploadStartInput {
  projectId: number;
  scriptId?: number | null;
  targetKind: "asset" | "storyboard";
  targetId: number;
  remoteProjectName: string;
  groupId: string;
  groupType: "AIGC";
  name?: string;
  assetType: "Image" | "Video" | "Audio";
  mode: "uploadOnly" | "uploadAndBind";
  expectedSourceVersion: number;
  expectedSourceFileHash: string;
  expectedBindingVersion: number | null;
  idempotencyKey: string;
}

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function errorView(error: unknown): UploadErrorView {
  if (error instanceof VolcengineTrustedAssetError) return { code: error.code, message: error.message.slice(0, 500) };
  return { code: "UPSTREAM_FAILED", message: "火山素材库请求未获得明确结果" };
}
function traceName(name: string | undefined, key: string, fallback: string): string {
  const suffix = ` [TF-${sha(key).slice(0, 10)}]`;
  const base = (name?.trim() || fallback).replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return `${base.slice(0, Math.max(1, 64 - suffix.length)).trim()}${suffix}`;
}
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
function groupView(row: any) {
  const status: GroupCreationStatus = row.status === "prepared" ? "submission_unknown" : row.status;
  return {
    operationId: String(row.operationId), projectId: Number(row.projectId), idempotencyKey: String(row.idempotencyKey), remoteProjectName: String(row.remoteProjectName),
    groupType: "AIGC" as const, name: String(row.name), remoteName: String(row.remoteName), description: String(row.description ?? ""), status,
    remoteGroupId: row.remoteGroupId == null ? null : String(row.remoteGroupId), error: parseJson<UploadErrorView | null>(row.error, null), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
  };
}
function uploadView(row: any) {
  const status: AssetUploadStatus = row.status === "prepared" ? "submission_unknown" : row.status;
  return {
    operationId: String(row.operationId), projectId: Number(row.projectId), scriptId: row.scriptId == null ? null : Number(row.scriptId), targetKind: row.targetKind as "asset" | "storyboard", targetId: Number(row.targetId),
    idempotencyKey: String(row.idempotencyKey), remoteProjectName: String(row.remoteProjectName), groupId: String(row.groupId), groupType: "AIGC" as const, assetType: row.assetType as "Image" | "Video" | "Audio",
    name: String(row.name ?? ""), remoteName: String(row.remoteName), mode: row.mode as "uploadOnly" | "uploadAndBind", expectedBindingVersion: row.expectedBindingVersion == null ? null : Number(row.expectedBindingVersion),
    sourceVersion: Number(row.sourceVersion), sourceFileHash: String(row.sourceFileHash), status, remoteAssetId: row.remoteAssetId == null ? null : String(row.remoteAssetId),
    remoteStatus: row.remoteStatus == null ? null : row.remoteStatus as "Processing" | "Active" | "Failed", bindStatus: row.bindStatus as AssetUploadBindStatus,
    error: parseJson<UploadErrorView | null>(row.error, null), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
  };
}

export async function ensureVolcengineAssetUploadSchema(db: Knex): Promise<void> {
  await db.transaction(async (trx) => {
    if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", ["toonflow:volcengine-upload-schema"]);
    if (!(await trx.schema.hasTable(GROUP_OPERATIONS))) await trx.schema.createTable(GROUP_OPERATIONS, (table) => {
      table.text("operationId").primary(); table.bigInteger("projectId").notNullable(); table.text("actorId").notNullable(); table.text("idempotencyKey").notNullable(); table.text("requestHash").notNullable();
      table.text("remoteProjectName").notNullable(); table.text("name").notNullable(); table.text("remoteName").notNullable(); table.text("description").notNullable(); table.text("status").notNullable();
      table.text("remoteGroupId").nullable(); table.text("error").nullable(); table.bigInteger("createdAt").notNullable(); table.bigInteger("updatedAt").notNullable(); table.unique(["projectId", "idempotencyKey"]); table.index(["projectId", "updatedAt"]);
    });
    if (!(await trx.schema.hasTable(UPLOAD_OPERATIONS))) await trx.schema.createTable(UPLOAD_OPERATIONS, (table) => {
      table.text("operationId").primary(); table.bigInteger("projectId").notNullable(); table.bigInteger("scriptId").nullable(); table.text("targetKind").notNullable(); table.bigInteger("targetId").notNullable();
      table.text("actorId").notNullable(); table.text("idempotencyKey").notNullable(); table.text("requestHash").notNullable(); table.text("remoteProjectName").notNullable(); table.text("groupId").notNullable(); table.text("assetType").notNullable();
      table.text("name").notNullable(); table.text("remoteName").notNullable(); table.text("mode").notNullable(); table.integer("expectedBindingVersion").nullable(); table.integer("sourceVersion").notNullable(); table.text("sourceFilePath").notNullable();
      table.text("sourceFileHash").notNullable(); table.text("contentHash").notNullable(); table.bigInteger("sizeBytes").notNullable();
      if (isPostgres(trx)) table.specificType("mtimeMs", "double precision").notNullable(); else table.float("mtimeMs").notNullable();
      table.text("leaseId").notNullable(); table.bigInteger("leaseExpiresAt").notNullable();
      table.text("status").notNullable(); table.text("remoteAssetId").nullable(); table.text("remoteStatus").nullable(); table.text("bindStatus").notNullable(); table.text("error").nullable(); table.bigInteger("createdAt").notNullable(); table.bigInteger("updatedAt").notNullable();
      table.unique(["projectId", "idempotencyKey"]); table.index(["projectId", "targetKind", "targetId", "updatedAt"]);
    });
    if (isPostgres(trx)) {
      const column = await trx(UPLOAD_OPERATIONS).columnInfo("mtimeMs");
      if (["real", "float4"].includes(column.type)) await trx.raw("ALTER TABLE ?? ALTER COLUMN ?? TYPE double precision USING ??::double precision", [UPLOAD_OPERATIONS, "mtimeMs", "mtimeMs"]);
    }
  });
}

const groupStartSchema = z.object({ projectId: z.number().int().positive(), remoteProjectName, name: z.string().trim().min(1).max(64), description: z.string().trim().max(300).optional(), groupType: z.literal("AIGC"), idempotencyKey }).strict();
const uploadStartSchema = z.object({
  projectId: z.number().int().positive(), scriptId: z.number().int().positive().nullable().optional(), targetKind: z.enum(["asset", "storyboard"]), targetId: z.number().int().positive(), remoteProjectName,
  groupId: remoteId, groupType: z.literal("AIGC"), name: z.string().trim().max(64).optional(), assetType: mediaType, mode: z.enum(["uploadOnly", "uploadAndBind"]), expectedSourceVersion: z.number().int().nonnegative(),
  expectedSourceFileHash: sourceHash, expectedBindingVersion: z.number().int().nonnegative().nullable(), idempotencyKey,
}).strict().superRefine((value, ctx) => {
  if (value.targetKind === "storyboard" && value.scriptId == null) ctx.addIssue({ code: "custom", message: "分镜上传必须提供 scriptId" });
  if (value.mode === "uploadAndBind" && value.expectedBindingVersion == null) ctx.addIssue({ code: "custom", message: "上传并绑定必须提供 expectedBindingVersion" });
});

export async function startVolcengineAssetGroupCreation(db: Knex, client: VolcengineTrustedAssetClient, raw: unknown, actorId: string, now = Date.now()) {
  await ensureVolcengineAssetUploadSchema(db);
  const input = groupStartSchema.parse(raw), requestHash = sha(stable(input));
  const existing = await db(GROUP_OPERATIONS).where({ projectId: input.projectId, idempotencyKey: input.idempotencyKey }).first();
  if (existing) {
    if (existing.requestHash !== requestHash) throw new VolcengineTrustedAssetError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同素材组请求", 409);
    if (existing.status !== "prepared") return groupView(existing);
  }
  const operationId = randomUUID(), remoteName = traceName(input.name, `${actorId}:${input.projectId}:${requestHash}`, "Toonflow 虚拟素材组");
  await db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const raced = await trx(GROUP_OPERATIONS).where({ projectId: input.projectId, idempotencyKey: input.idempotencyKey }).first();
    if (raced) { if (raced.requestHash !== requestHash) throw new VolcengineTrustedAssetError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同素材组请求", 409); return; }
    await trx(GROUP_OPERATIONS).insert({ operationId, projectId: input.projectId, actorId, idempotencyKey: input.idempotencyKey, requestHash, remoteProjectName: input.remoteProjectName, name: input.name, remoteName, description: input.description ?? "", status: "prepared", remoteGroupId: null, error: null, createdAt: now, updatedAt: now });
  });
  const row = await db(GROUP_OPERATIONS).where({ projectId: input.projectId, idempotencyKey: input.idempotencyKey }).first();
  if (row.status !== "prepared") return groupView(row);
  const claimed = await db(GROUP_OPERATIONS).where({ operationId: row.operationId, status: "prepared" }).update({ status: "submission_unknown", updatedAt: Date.now() });
  if (!Number(claimed)) return groupView(await db(GROUP_OPERATIONS).where({ operationId: row.operationId }).first());
  try {
    const created = await client.createGroup({ name: row.remoteName, description: row.description, groupType: "AIGC", projectName: row.remoteProjectName });
    await db(GROUP_OPERATIONS).where({ operationId: row.operationId, status: "submission_unknown" }).update({ status: "created", remoteGroupId: created.id, error: null, updatedAt: Date.now() });
  } catch (error) {
    const view = errorView(error), rejected = error instanceof VolcengineTrustedAssetError && error.code === "UPSTREAM_REJECTED";
    await db(GROUP_OPERATIONS).where({ operationId: row.operationId, status: "submission_unknown" }).update({ ...(rejected ? { status: "rejected" } : {}), error: JSON.stringify(view), updatedAt: Date.now() });
  }
  return groupView(await db(GROUP_OPERATIONS).where({ operationId: row.operationId }).first());
}

async function findGroupOperation(db: Knex, raw: unknown) {
  const input = lookup.parse(raw), query = db(GROUP_OPERATIONS).where({ projectId: input.projectId });
  if (input.operationId) query.where({ operationId: input.operationId }); else query.where({ idempotencyKey: input.idempotencyKey });
  const row = await query.first(); if (!row) throw new VolcengineTrustedAssetError("NOT_FOUND", "未找到素材组创建记录", 404); return row;
}
export async function getVolcengineAssetGroupCreation(db: Knex, raw: unknown) { await ensureVolcengineAssetUploadSchema(db); return groupView(await findGroupOperation(db, raw)); }
export async function listVolcengineAssetGroupCreations(db: Knex, raw: unknown) {
  await ensureVolcengineAssetUploadSchema(db); const input = z.object({ projectId: z.number().int().positive() }).strict().parse(raw);
  return { items: (await db(GROUP_OPERATIONS).where({ projectId: input.projectId }).orderBy("createdAt", "desc").limit(100)).map(groupView) };
}
export async function syncVolcengineAssetGroupCreation(db: Knex, client: VolcengineTrustedAssetClient, raw: unknown) {
  await ensureVolcengineAssetUploadSchema(db); const row = await findGroupOperation(db, raw); if (row.status !== "submission_unknown") return groupView(row);
  const found = (await client.listGroups({ projectName: row.remoteProjectName, groupType: "AIGC", name: row.remoteName, maxResults: 100 })).items.filter((item) => item.name === row.remoteName && item.groupType === "AIGC");
  if (found.length === 1) await db(GROUP_OPERATIONS).where({ operationId: row.operationId, status: "submission_unknown" }).update({ status: "created", remoteGroupId: found[0].id, error: null, updatedAt: Date.now() });
  else if (found.length > 1) await db(GROUP_OPERATIONS).where({ operationId: row.operationId }).update({ error: JSON.stringify({ code: "RECOVERY_AMBIGUOUS", message: "发现多个同名远端素材组，无法自动确认原请求结果" }), updatedAt: Date.now() });
  return groupView(await db(GROUP_OPERATIONS).where({ operationId: row.operationId }).first());
}

function fps(value: unknown): number {
  const [left, right = "1"] = String(value ?? "0").split("/"); const result = Number(left) / Number(right); return Number.isFinite(result) ? result : 0;
}
async function inspectUploadSource(absolutePath: string, type: "Image" | "Video" | "Audio", sizeBytes: number): Promise<void> {
  const ext = path.extname(absolutePath).toLowerCase();
  if (type === "Image") {
    if (sizeBytes >= 30 * 1024 * 1024) throw new VolcengineTrustedAssetError("INVALID_INPUT", "图片必须小于 30 MB");
    if (![".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) throw new VolcengineTrustedAssetError("INVALID_INPUT", "当前 Toonflow 媒体桥仅支持 JPG、PNG、WebP、GIF 上传到火山素材库");
    const metadata = await sharp(absolutePath).metadata(); const width = Number(metadata.width), height = Number(metadata.height), ratio = width / height;
    if (!Number.isFinite(ratio) || width <= 300 || width >= 6000 || height <= 300 || height >= 6000 || ratio <= 0.4 || ratio >= 2.5) throw new VolcengineTrustedAssetError("INVALID_INPUT", "图片宽高须在 300–6000 px 之间，宽高比须在 0.4–2.5 之间（均不含边界）");
    return;
  }
  if (type === "Video" && sizeBytes > 100 * 1024 * 1024) throw new VolcengineTrustedAssetError("INVALID_INPUT", "当前 Toonflow 受控媒体桥的视频上限为 100 MB");
  if (type === "Audio" && sizeBytes > 15 * 1024 * 1024) throw new VolcengineTrustedAssetError("INVALID_INPUT", "音频不能超过 15 MB");
  if (type === "Video" && ![".mp4", ".mov"].includes(ext)) throw new VolcengineTrustedAssetError("INVALID_INPUT", "火山素材库视频仅支持 MP4、MOV");
  if (type === "Audio" && ![".wav", ".mp3"].includes(ext)) throw new VolcengineTrustedAssetError("INVALID_INPUT", "火山素材库音频仅支持 WAV、MP3");
  let data: any;
  try { const result = await execFileAsync(ffprobePath, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", absolutePath], { timeout: 30_000, maxBuffer: 1_000_000 }); data = JSON.parse(result.stdout); }
  catch { throw new VolcengineTrustedAssetError("INVALID_INPUT", "无法读取音视频时长或编码信息"); }
  const streams = Array.isArray(data?.streams) ? data.streams : [], formatDuration = Number(data?.format?.duration);
  if (type === "Audio") {
    const audio = streams.find((item: any) => item.codec_type === "audio"), duration = Number(audio?.duration ?? formatDuration);
    if (!audio || !Number.isFinite(duration) || duration < 2 || duration > 30) throw new VolcengineTrustedAssetError("INVALID_INPUT", "音频时长必须为 2–30 秒");
    return;
  }
  const video = streams.find((item: any) => item.codec_type === "video"), width = Number(video?.width), height = Number(video?.height), duration = Number(video?.duration ?? formatDuration), frameRate = fps(video?.avg_frame_rate ?? video?.r_frame_rate), ratio = width / height, pixels = width * height;
  if (!video || !Number.isFinite(duration) || duration < 2 || duration > 30 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 300 || width > 6000 || height < 300 || height > 6000 || ratio < 0.4 || ratio > 2.5 || pixels < 407696 || pixels > 8295044 || frameRate < 24 || frameRate > 60) {
    throw new VolcengineTrustedAssetError("INVALID_INPUT", "视频须为 2–30 秒、24–60 FPS、边长 300–6000 px、宽高比 0.4–2.5，且像素数满足火山素材库限制");
  }
}

export function createVolcengineAssetUploadRuntime(db: Knex, bridge: Omit<VideoReferenceLeaseOptions, "maxBytes">, hashSource: (filePath: string) => Promise<string>): VolcengineAssetUploadRuntime {
  return {
    hashSource,
    async prepareSource(input) {
      const target: LocalReferenceTarget = { projectId: input.projectId, scriptId: input.scriptId, targetKind: input.targetKind, targetId: input.targetId };
      const source = await readLocalVolcengineReferenceSource(db, target);
      if (!source.filePath) throw new VolcengineTrustedAssetError("INVALID_INPUT", "本地目标尚无当前媒体，不能上传");
      const actualType = ({ image: "Image", video: "Video", audio: "Audio" } as const)[source.mediaType];
      if (actualType !== input.assetType) throw new VolcengineTrustedAssetError("INVALID_INPUT", "上传类型与本地当前媒体不一致");
      const currentHash = await hashSource(source.filePath);
      if (source.version !== input.expectedSourceVersion || currentHash !== input.expectedSourceFileHash) throw new VolcengineTrustedAssetError("VERSION_CONFLICT", "本地来源已变化，请重新读取后上传", 409);
      const options = { ...bridge, maxBytes: input.assetType === "Image" ? 30 * 1024 * 1024 : input.assetType === "Audio" ? 15 * 1024 * 1024 : 100 * 1024 * 1024 };
      const lease = input.targetKind === "asset" && source.scriptId == null
        ? await issueProjectAssetReferenceLease(db, { projectId: input.projectId, id: input.targetId, fileType: source.mediaType }, options)
        : await issueVideoReferenceLease(db, { projectId: input.projectId, scriptId: Number(source.scriptId), id: input.targetId, sources: input.targetKind === "asset" ? "assets" : "storyboard", fileType: source.mediaType }, options);
      await inspectUploadSource(resolveBridgeFilePath(bridge.rootDir, source.filePath), input.assetType, lease.sizeBytes);
      if (await hashSource(source.filePath) !== currentHash) throw new VolcengineTrustedAssetError("VERSION_CONFLICT", "媒体检查期间本地来源已变化，请重试", 409);
      return { sourceVersion: source.version, sourceFilePath: source.filePath, sourceFileHash: currentHash, mediaType: input.assetType, leaseUrl: lease.url, leaseId: lease.leaseId, contentHash: lease.contentHash, sizeBytes: lease.sizeBytes, mtimeMs: lease.mtimeMs, expiresAt: lease.expiresAt };
    },
  };
}

export async function startVolcengineAssetUpload(db: Knex, client: VolcengineTrustedAssetClient, raw: unknown, actorId: string, runtime: VolcengineAssetUploadRuntime, now = Date.now()) {
  await ensureVolcengineAssetUploadSchema(db); const input = uploadStartSchema.parse(raw) as UploadStartInput, requestHash = sha(stable(input));
  const existing = await db(UPLOAD_OPERATIONS).where({ projectId: input.projectId, idempotencyKey: input.idempotencyKey }).first();
  if (existing) {
    if (existing.requestHash !== requestHash) throw new VolcengineTrustedAssetError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同上传请求", 409);
    if (existing.status !== "prepared") return uploadView(existing);
  }
  const source = await runtime.prepareSource(input);
  const group = await client.getGroup({ id: input.groupId, projectName: input.remoteProjectName });
  if (group.groupType !== "AIGC" || group.projectName !== input.remoteProjectName) throw new VolcengineTrustedAssetError("INVALID_INPUT", "Toonflow 只允许向当前项目的 AIGC 虚拟素材组上传");
  const operationId = randomUUID(), remoteName = traceName(input.name, `${actorId}:${input.projectId}:${input.targetKind}:${input.targetId}:${requestHash}`, `${input.targetKind}-${input.targetId}`), bindStatus = input.mode === "uploadAndBind" ? "pending" : "not_requested";
  await db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const raced = await trx(UPLOAD_OPERATIONS).where({ projectId: input.projectId, idempotencyKey: input.idempotencyKey }).first();
    if (raced) { if (raced.requestHash !== requestHash) throw new VolcengineTrustedAssetError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同上传请求", 409); return; }
    const current = await readLocalVolcengineReferenceSource(trx, input);
    if (current.version !== source.sourceVersion || current.filePath !== source.sourceFilePath) throw new VolcengineTrustedAssetError("VERSION_CONFLICT", "提交前本地来源已变化，请重试", 409);
    await trx(UPLOAD_OPERATIONS).insert({ operationId, projectId: input.projectId, scriptId: input.scriptId ?? null, targetKind: input.targetKind, targetId: input.targetId, actorId, idempotencyKey: input.idempotencyKey, requestHash,
      remoteProjectName: input.remoteProjectName, groupId: input.groupId, assetType: input.assetType, name: input.name ?? "", remoteName, mode: input.mode, expectedBindingVersion: input.expectedBindingVersion,
      sourceVersion: source.sourceVersion, sourceFilePath: source.sourceFilePath, sourceFileHash: source.sourceFileHash, contentHash: source.contentHash, sizeBytes: source.sizeBytes, mtimeMs: source.mtimeMs, leaseId: source.leaseId, leaseExpiresAt: source.expiresAt,
      status: "prepared", remoteAssetId: null, remoteStatus: null, bindStatus, error: null, createdAt: now, updatedAt: now });
  });
  const row = await db(UPLOAD_OPERATIONS).where({ projectId: input.projectId, idempotencyKey: input.idempotencyKey }).first();
  if (row.status !== "prepared") return uploadView(row);
  if (row.contentHash !== source.contentHash || Number(row.sizeBytes) !== source.sizeBytes || Math.abs(Number(row.mtimeMs) - source.mtimeMs) > 0.5) throw new VolcengineTrustedAssetError("VERSION_CONFLICT", "待提交来源与已记录上传意图不一致", 409);
  const claimed = await db(UPLOAD_OPERATIONS).where({ operationId: row.operationId, status: "prepared" }).update({ status: "submission_unknown", leaseId: source.leaseId, leaseExpiresAt: source.expiresAt, updatedAt: Date.now() });
  if (!Number(claimed)) return uploadView(await db(UPLOAD_OPERATIONS).where({ operationId: row.operationId }).first());
  try {
    const created = await client.createAsset({ groupId: row.groupId, name: row.remoteName, assetType: row.assetType, projectName: row.remoteProjectName, url: source.leaseUrl });
    await db(UPLOAD_OPERATIONS).where({ operationId: row.operationId, status: "submission_unknown" }).update({ status: "processing", remoteAssetId: created.id, remoteStatus: "Processing", error: null, updatedAt: Date.now() });
  } catch (error) {
    const view = errorView(error), rejected = error instanceof VolcengineTrustedAssetError && error.code === "UPSTREAM_REJECTED";
    await db(UPLOAD_OPERATIONS).where({ operationId: row.operationId, status: "submission_unknown" }).update({ ...(rejected ? { status: "rejected" } : {}), error: JSON.stringify(view), updatedAt: Date.now() });
  }
  return uploadView(await db(UPLOAD_OPERATIONS).where({ operationId: row.operationId }).first());
}

async function findUpload(db: Knex, raw: unknown) {
  const input = lookup.parse(raw), query = db(UPLOAD_OPERATIONS).where({ projectId: input.projectId });
  if (input.operationId) query.where({ operationId: input.operationId }); else query.where({ idempotencyKey: input.idempotencyKey });
  const row = await query.first(); if (!row) throw new VolcengineTrustedAssetError("NOT_FOUND", "未找到素材上传记录", 404); return row;
}
export async function getVolcengineAssetUpload(db: Knex, raw: unknown) { await ensureVolcengineAssetUploadSchema(db); return uploadView(await findUpload(db, raw)); }
export async function listVolcengineAssetUploads(db: Knex, raw: unknown) {
  await ensureVolcengineAssetUploadSchema(db);
  const input = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive().nullable().optional(), targetKind: z.enum(["asset", "storyboard"]).optional(), targetId: z.number().int().positive().optional() }).strict().parse(raw);
  const query = db(UPLOAD_OPERATIONS).where({ projectId: input.projectId }); if (input.scriptId !== undefined) query.where({ scriptId: input.scriptId }); if (input.targetKind) query.where({ targetKind: input.targetKind }); if (input.targetId) query.where({ targetId: input.targetId });
  return { items: (await query.orderBy("createdAt", "desc").limit(100)).map(uploadView) };
}

async function finalizeUploadBinding(db: Knex, client: VolcengineTrustedAssetClient, row: any, runtime: VolcengineAssetUploadRuntime): Promise<void> {
  if (row.mode !== "uploadAndBind" || row.bindStatus !== "pending" || !row.remoteAssetId) return;
  try {
    await replaceVolcengineReferenceBindings(db, client, { projectId: Number(row.projectId), scriptId: row.scriptId == null ? null : Number(row.scriptId), targetKind: row.targetKind, targetId: Number(row.targetId), expectedVersion: Number(row.expectedBindingVersion),
      expectedSourceVersion: Number(row.sourceVersion), expectedSourceFileHash: String(row.sourceFileHash), idempotencyKey: `upload-bind:${row.operationId}`, items: [{ remoteProjectName: row.remoteProjectName, groupType: "AIGC", groupId: row.groupId, assetId: row.remoteAssetId, assetType: row.assetType }] }, row.actorId, runtime.hashSource);
    await db(UPLOAD_OPERATIONS).where({ operationId: row.operationId, bindStatus: "pending" }).update({ bindStatus: "bound", error: null, updatedAt: Date.now() });
  } catch (error) {
    const conflict = error instanceof VolcengineTrustedAssetError && ["VERSION_CONFLICT", "STALE_BINDING"].includes(error.code);
    const retryable = error instanceof VolcengineTrustedAssetError && ["UPSTREAM_FAILED", "CONFIG_REQUIRED"].includes(error.code);
    await db(UPLOAD_OPERATIONS).where({ operationId: row.operationId, bindStatus: "pending" }).update({ bindStatus: conflict ? "conflict" : retryable ? "pending" : "failed", error: JSON.stringify(errorView(error)), updatedAt: Date.now() });
  }
}

export async function syncVolcengineAssetUpload(db: Knex, client: VolcengineTrustedAssetClient, raw: unknown, runtime: VolcengineAssetUploadRuntime) {
  await ensureVolcengineAssetUploadSchema(db); let row = await findUpload(db, raw);
  if (["failed", "rejected"].includes(row.status)) return uploadView(row);
  if (row.status === "submission_unknown" && !row.remoteAssetId) {
    const found = (await client.listAssets({ projectName: row.remoteProjectName, groupType: "AIGC", groupIds: [row.groupId], name: row.remoteName, maxResults: 100 })).items.filter((item) => item.name === row.remoteName && item.groupId === row.groupId && item.assetType === row.assetType);
    if (found.length === 1) await db(UPLOAD_OPERATIONS).where({ operationId: row.operationId, status: "submission_unknown" }).update({ remoteAssetId: found[0].id, remoteStatus: found[0].status, status: found[0].status === "Active" ? "active" : found[0].status === "Failed" ? "failed" : "processing", error: found[0].error ? JSON.stringify(found[0].error) : null, updatedAt: Date.now() });
    else if (found.length > 1) await db(UPLOAD_OPERATIONS).where({ operationId: row.operationId }).update({ error: JSON.stringify({ code: "RECOVERY_AMBIGUOUS", message: "发现多个同名远端素材，无法自动确认原上传结果" }), updatedAt: Date.now() });
    row = await db(UPLOAD_OPERATIONS).where({ operationId: row.operationId }).first();
  }
  if (row.remoteAssetId && row.status !== "rejected") {
    const asset = await client.getAsset({ id: row.remoteAssetId, projectName: row.remoteProjectName });
    if (asset.groupId !== row.groupId || asset.assetType !== row.assetType) throw new VolcengineTrustedAssetError("UPSTREAM_FAILED", "远端素材身份与上传记录不一致", 502);
    const status: AssetUploadStatus = asset.status === "Active" ? "active" : asset.status === "Failed" ? "failed" : "processing";
    await db(UPLOAD_OPERATIONS).where({ operationId: row.operationId }).update({ status, remoteStatus: asset.status, error: asset.error ? JSON.stringify(asset.error) : null, updatedAt: Date.now() });
    row = await db(UPLOAD_OPERATIONS).where({ operationId: row.operationId }).first();
  }
  if (row.status === "active") { await finalizeUploadBinding(db, client, row, runtime); row = await db(UPLOAD_OPERATIONS).where({ operationId: row.operationId }).first(); }
  return uploadView(row);
}
