import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import { resolveVideoReferenceMediaType, type VideoReferenceMediaType } from "@/lib/videoPromptReferences";
import { resolveImageMediaOwnership, MediaOwnershipError } from "@/lib/mediaOwnership";

export type VideoReferenceSource = {
  projectId: number;
  scriptId: number;
  id: number;
  sources: "assets" | "storyboard";
  fileType?: VideoReferenceMediaType;
};

/** Project library uploads have no episode. Zero is reserved for this explicit
 * internal source kind; public video reference inputs still require an episode. */
type ProjectAssetReferenceSource = { projectId: number; scriptId: 0; id: number; sources: "projectAssets"; fileType?: VideoReferenceMediaType };
type BridgeReferenceSource = VideoReferenceSource | ProjectAssetReferenceSource;

export type VideoReferenceLeaseOptions = {
  rootDir: string;
  publicOrigin: string;
  secret: string;
  ttlMs?: number;
  hardTtlMs?: number;
  maxBytes?: number;
  now?: number;
};

export type VideoReferenceLease = {
  type: VideoReferenceMediaType;
  url: string;
  source: BridgeReferenceSource;
  leaseId: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
  expiresAt: number;
};

export type VideoReferenceLeaseRow = {
  leaseId: string;
  leaseHash: string;
  resourceKey: string;
  projectId: number;
  scriptId: number;
  sourceKind: "assets" | "storyboard" | "projectAssets";
  sourceId: number;
  filePath: string;
  mediaType: VideoReferenceMediaType;
  sizeBytes: number;
  mtimeMs: number;
  contentHash: string;
  createdAt: number;
  expiresAt: number;
  hardExpiresAt: number;
  revokedAt: number | null;
};

export class VideoReferenceBridgeError extends Error {
  constructor(public readonly code: "NOT_CONFIGURED" | "INVALID_INPUT" | "NOT_FOUND" | "PROJECT_MISMATCH" | "FILE_CHANGED" | "SIZE_LIMIT", message: string) {
    super(message);
    this.name = "VideoReferenceBridgeError";
  }
}

export const VIDEO_REFERENCE_BRIDGE_TTL_MS = 72 * 60 * 60 * 1000;
export const VIDEO_REFERENCE_BRIDGE_HARD_TTL_MS = 73 * 60 * 60 * 1000;
export const VIDEO_REFERENCE_BRIDGE_MAX_BYTES = 100 * 1024 * 1024;
const resourceLocks = new Map<string, Promise<unknown>>();

function isPostgres(db: Knex | Knex.Transaction): boolean {
  return String(((db as any).client?.config?.client ?? "")).toLowerCase() === "pg";
}

export async function ensureVideoReferenceBridgeSchema(db: Knex): Promise<void> {
  if (isPostgres(db)) {
    await db.raw(`
      CREATE TABLE IF NOT EXISTS "ext_video_reference_leases" (
        "leaseId" text PRIMARY KEY,
        "leaseHash" text NOT NULL UNIQUE,
        "resourceKey" text NOT NULL UNIQUE,
        "projectId" bigint NOT NULL,
        "scriptId" bigint NOT NULL,
        "sourceKind" text NOT NULL,
        "sourceId" bigint NOT NULL,
        "filePath" text NOT NULL,
        "mediaType" text NOT NULL,
        "sizeBytes" bigint NOT NULL,
        "mtimeMs" double precision NOT NULL,
        "contentHash" text NOT NULL,
        "createdAt" bigint NOT NULL,
        "expiresAt" bigint NOT NULL,
        "hardExpiresAt" bigint NOT NULL,
        "revokedAt" bigint
      )
    `);
    await db.raw(`CREATE INDEX IF NOT EXISTS "ext_video_reference_leases_expiry_idx" ON "ext_video_reference_leases" ("expiresAt")`);
    return;
  }
  if (!(await db.schema.hasTable("ext_video_reference_leases"))) {
    await db.schema.createTable("ext_video_reference_leases", (table) => {
      table.text("leaseId").primary();
      table.text("leaseHash").notNullable().unique();
      table.text("resourceKey").notNullable().unique();
      table.integer("projectId").notNullable();
      table.integer("scriptId").notNullable();
      table.text("sourceKind").notNullable();
      table.integer("sourceId").notNullable();
      table.text("filePath").notNullable();
      table.text("mediaType").notNullable();
      table.integer("sizeBytes").notNullable();
      table.float("mtimeMs").notNullable();
      table.text("contentHash").notNullable();
      table.integer("createdAt").notNullable();
      table.integer("expiresAt").notNullable();
      table.integer("hardExpiresAt").notNullable();
      table.integer("revokedAt");
      table.index(["expiresAt"]);
    });
  }
}

function positiveId(value: unknown, label: string): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new VideoReferenceBridgeError("INVALID_INPUT", `${label}无效`);
  return id;
}

function canonicalPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)) throw new VideoReferenceBridgeError("INVALID_INPUT", "媒体路径无效");
  const relative = value.replace(/^\/+/, "");
  if (!relative || relative.endsWith("/") || relative.includes("//") || relative.split("/").some((part) => part === "." || part === "..")) throw new VideoReferenceBridgeError("INVALID_INPUT", "媒体路径无效");
  return `/${relative}`;
}

export function resolveBridgeFilePath(rootDir: string, filePath: string): string {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) throw new VideoReferenceBridgeError("INVALID_INPUT", "媒体根目录无效");
  const canonical = canonicalPath(filePath);
  const root = path.resolve(rootDir);
  const absolute = path.resolve(root, canonical.slice(1));
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new VideoReferenceBridgeError("INVALID_INPUT", "媒体路径超出受控根目录");
  return absolute;
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new VideoReferenceBridgeError("INVALID_INPUT", "媒体文件超出受控根目录");
}

/** Resolve the root symlink itself, then open the resolved file without following a final symlink. */
export async function openStableVideoReferenceFile(rootDir: string, filePath: string): Promise<{ handle: fs.FileHandle; stat: Stats; absolutePath: string }> {
  const lexical = resolveBridgeFilePath(rootDir, filePath);
  let root: string;
  let target: string;
  try {
    root = await fs.realpath(rootDir);
    target = await fs.realpath(lexical);
  } catch {
    throw new VideoReferenceBridgeError("NOT_FOUND", "引用媒体文件不存在");
  }
  assertInside(root, target);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new VideoReferenceBridgeError("NOT_FOUND", "引用媒体文件不可用");
  }
  const stat = await handle.stat();
  if (!stat.isFile()) { await handle.close(); throw new VideoReferenceBridgeError("NOT_FOUND", "引用媒体不是文件"); }
  return { handle, stat, absolutePath: target };
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new VideoReferenceBridgeError("NOT_CONFIGURED", "未配置有效的媒体公网 origin"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new VideoReferenceBridgeError("NOT_CONFIGURED", "媒体公网 origin 必须是无路径的 HTTPS 地址");
  return parsed.origin;
}

export function videoReferenceContentType(mediaType: VideoReferenceMediaType, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const table: Record<VideoReferenceMediaType, Record<string, string>> = {
    image: { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" },
    video: { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v" },
    audio: { ".mp3": "audio/mpeg", ".mpeg": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".flac": "audio/flac", ".ogg": "audio/ogg", ".aac": "audio/aac" },
  };
  const mime = table[mediaType][ext];
  if (!mime) throw new VideoReferenceBridgeError("INVALID_INPUT", `不支持的${mediaType}参考文件格式`);
  return mime;
}

function bridgeSecret(value: string): string {
  if (typeof value !== "string" || value.length < 32) throw new VideoReferenceBridgeError("NOT_CONFIGURED", "未配置足够强度的媒体桥接 secret");
  return value;
}

function hashLeaseId(leaseId: string): string { return createHash("sha256").update(leaseId).digest("hex"); }
function signLeaseId(leaseId: string, secret: string): string { return createHmac("sha256", secret).update(leaseId).digest("base64url"); }
function tokenFor(leaseId: string, secret: string): string { return `${leaseId}.${signLeaseId(leaseId, secret)}`; }

export function verifyVideoReferenceToken(token: string, secret: string): string {
  bridgeSecret(secret);
  if (typeof token !== "string") throw new VideoReferenceBridgeError("NOT_FOUND", "媒体桥接令牌无效");
  const [leaseId, signature, extra] = token.split(".");
  if (extra || !/^[A-Za-z0-9_-]{32,128}$/.test(leaseId || "") || !/^[A-Za-z0-9_-]{40,100}$/.test(signature || "")) throw new VideoReferenceBridgeError("NOT_FOUND", "媒体桥接令牌无效");
  const expected = Buffer.from(signLeaseId(leaseId, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new VideoReferenceBridgeError("NOT_FOUND", "媒体桥接令牌无效");
  return leaseId;
}

async function resolveSource(db: Knex, source: BridgeReferenceSource): Promise<{ filePath: string; mediaType: VideoReferenceMediaType }> {
  const projectId = positiveId(source.projectId, "projectId");
  const id = positiveId(source.id, "引用素材 ID");
  if (source.sources === "projectAssets") {
    if (source.scriptId !== 0) throw new VideoReferenceBridgeError("INVALID_INPUT", "项目素材上传来源不合法");
    const row = await db("o_assets as asset").join("o_image as image", "image.id", "asset.imageId")
      .where({ "asset.id": id, "asset.projectId": projectId }).select("image.filePath", "image.type").first();
    if (!row?.filePath) throw new VideoReferenceBridgeError("PROJECT_MISMATCH", "上传素材不属于当前项目或没有当前媒体");
    const filePath = canonicalPath(row.filePath);
    await assertProjectPathOwnership(db, projectId, filePath);
    return { filePath, mediaType: resolveVideoReferenceMediaType(source.fileType, row.type, filePath) };
  }
  const scriptId = positiveId(source.scriptId, "scriptId");
  if (source.sources === "storyboard") {
    const row = await db("o_storyboard as storyboard")
      .join("o_script as script", "script.id", "storyboard.scriptId")
      .where("storyboard.id", id).where("script.id", scriptId).where("script.projectId", projectId)
      .select("storyboard.filePath").first();
    if (!row?.filePath) throw new VideoReferenceBridgeError("PROJECT_MISMATCH", "分镜引用不属于当前项目或没有媒体文件");
    const filePath = canonicalPath(row.filePath);
    await assertProjectPathOwnership(db, projectId, filePath);
    return { filePath, mediaType: "image" };
  }
  const row = await db("o_assets")
    .join("o_scriptAssets as scriptAsset", "scriptAsset.assetId", "o_assets.id")
    .join("o_script as script", "script.id", "scriptAsset.scriptId")
    .leftJoin("o_image", "o_assets.imageId", "o_image.id")
    .where("o_assets.id", id).where("o_assets.projectId", projectId)
    .where("script.id", scriptId).where("script.projectId", projectId)
    .select("o_image.filePath", "o_image.type").first();
  if (!row?.filePath) throw new VideoReferenceBridgeError("PROJECT_MISMATCH", "资产引用不属于当前项目或没有媒体文件");
  const filePath = canonicalPath(row.filePath);
  await assertProjectPathOwnership(db, projectId, filePath);
  return { filePath, mediaType: resolveVideoReferenceMediaType(source.fileType, row.type, row.filePath) };
}

async function assertProjectPathOwnership(db: Knex, projectId: number, filePath: string): Promise<void> {
  try {
    const ownership = await resolveImageMediaOwnership(db, filePath);
    if (ownership.projectId !== projectId) throw new VideoReferenceBridgeError("PROJECT_MISMATCH", "媒体文件不属于当前项目");
  } catch (error) {
    if (error instanceof VideoReferenceBridgeError) throw error;
    if (error instanceof MediaOwnershipError) throw new VideoReferenceBridgeError("PROJECT_MISMATCH", "媒体文件没有当前项目的唯一归属");
    throw error;
  }
}

async function assertLeaseSourceStillOwned(db: Knex, lease: VideoReferenceLeaseRow): Promise<void> {
  if (await db.schema.hasTable("o_project") && !(await db("o_project").where({ id: lease.projectId }).first())) {
    throw new VideoReferenceBridgeError("PROJECT_MISMATCH", "媒体租约所属项目已不存在");
  }
  if (lease.sourceKind === "projectAssets") {
    const current = await resolveSource(db, { projectId: lease.projectId, scriptId: 0, id: lease.sourceId, sources: "projectAssets" });
    if (lease.scriptId !== 0 || current.filePath !== lease.filePath || current.mediaType !== lease.mediaType) throw new VideoReferenceBridgeError("FILE_CHANGED", "项目素材已更换，旧上传地址已失效");
    return;
  }
  if (!(await db("o_script").where({ id: lease.scriptId, projectId: lease.projectId }).first())) throw new VideoReferenceBridgeError("PROJECT_MISMATCH", "媒体租约所属剧本已不存在或归属已变化");
  if (lease.sourceKind === "storyboard") {
    if (!(await db("o_storyboard").where({ id: lease.sourceId, projectId: lease.projectId, scriptId: lease.scriptId }).first())) throw new VideoReferenceBridgeError("PROJECT_MISMATCH", "媒体租约所属分镜已不存在或归属已变化");
  } else {
    const asset = await db("o_assets").where({ id: lease.sourceId, projectId: lease.projectId }).first();
    const linked = await db("o_scriptAssets").where({ scriptId: lease.scriptId, assetId: lease.sourceId }).first();
    if (!asset || !linked) throw new VideoReferenceBridgeError("PROJECT_MISMATCH", "媒体租约所属资产已不存在或归属已变化");
  }
  await assertProjectPathOwnership(db, lease.projectId, lease.filePath);
}

async function fileFingerprint(rootDir: string, filePath: string, mediaType: VideoReferenceMediaType, maxBytes: number): Promise<{ sizeBytes: number; mtimeMs: number; contentHash: string }> {
  const opened = await openStableVideoReferenceFile(rootDir, filePath);
  const { handle, stat } = opened;
  try {
    videoReferenceContentType(mediaType, filePath);
    if (!Number.isSafeInteger(stat.size) || stat.size <= 0) throw new VideoReferenceBridgeError("NOT_FOUND", "引用媒体文件为空或大小无效");
    if (stat.size > maxBytes) throw new VideoReferenceBridgeError("SIZE_LIMIT", `引用媒体超过 ${maxBytes} 字节限制`);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (after.size !== stat.size || Math.abs(after.mtimeMs - stat.mtimeMs) > 0.5) throw new VideoReferenceBridgeError("FILE_CHANGED", "媒体文件在指纹读取期间发生变化");
    return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs, contentHash: hash.digest("hex") };
  } finally { await handle.close(); }
}

function resourceKey(source: BridgeReferenceSource, filePath: string, fingerprint: { sizeBytes: number; mtimeMs: number; contentHash: string }): string {
  return createHash("sha256").update(JSON.stringify([source.projectId, source.scriptId, source.sources, source.id, filePath, fingerprint.sizeBytes, fingerprint.mtimeMs, fingerprint.contentHash])).digest("hex");
}

function rowFromDb(row: any): VideoReferenceLeaseRow {
  return {
    leaseId: String(row.leaseId), leaseHash: String(row.leaseHash), resourceKey: String(row.resourceKey), projectId: Number(row.projectId), scriptId: Number(row.scriptId),
    sourceKind: row.sourceKind, sourceId: Number(row.sourceId), filePath: String(row.filePath), mediaType: row.mediaType, sizeBytes: Number(row.sizeBytes), mtimeMs: Number(row.mtimeMs),
    contentHash: String(row.contentHash), createdAt: Number(row.createdAt), expiresAt: Number(row.expiresAt), hardExpiresAt: Number(row.hardExpiresAt), revokedAt: row.revokedAt == null ? null : Number(row.revokedAt),
  };
}

function leaseResult(row: VideoReferenceLeaseRow, source: BridgeReferenceSource, origin: string, secret: string, expiresAt: number): VideoReferenceLease {
  return { type: row.mediaType, url: `${origin}/media-bridge/${tokenFor(row.leaseId, secret)}`, source, leaseId: row.leaseId, contentHash: row.contentHash, sizeBytes: row.sizeBytes, mtimeMs: row.mtimeMs, expiresAt };
}

async function withResourceLock<T>(db: Knex, key: string, fn: (conn: Knex) => Promise<T>): Promise<T> {
  const prior = resourceLocks.get(key) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(async () => {
    if (isPostgres(db)) return db.transaction(async (trx) => {
      await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [`toonflow:media-lease:${key}`]);
      return fn(trx as unknown as Knex);
    });
    return fn(db);
  });
  resourceLocks.set(key, current);
  try { return await current; }
  finally { if (resourceLocks.get(key) === current) resourceLocks.delete(key); }
}

export async function issueVideoReferenceLease(db: Knex, source: VideoReferenceSource, options: VideoReferenceLeaseOptions): Promise<VideoReferenceLease> {
  if (!["assets", "storyboard"].includes(source.sources)) throw new VideoReferenceBridgeError("INVALID_INPUT", "视频引用来源不合法");
  positiveId(source.scriptId, "scriptId");
  return issueBridgeReferenceLease(db, source, options);
}

export async function issueProjectAssetReferenceLease(db: Knex, source: { projectId: number; id: number; fileType?: VideoReferenceMediaType }, options: VideoReferenceLeaseOptions): Promise<VideoReferenceLease> {
  return issueBridgeReferenceLease(db, { ...source, scriptId: 0, sources: "projectAssets" }, { ...options, ttlMs: options.ttlMs ?? 60 * 60 * 1000, hardTtlMs: options.hardTtlMs ?? 2 * 60 * 60 * 1000 });
}

async function issueBridgeReferenceLease(db: Knex, source: BridgeReferenceSource, options: VideoReferenceLeaseOptions): Promise<VideoReferenceLease> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? VIDEO_REFERENCE_BRIDGE_TTL_MS;
  const hardTtlMs = options.hardTtlMs ?? VIDEO_REFERENCE_BRIDGE_HARD_TTL_MS;
  const maxBytes = options.maxBytes ?? VIDEO_REFERENCE_BRIDGE_MAX_BYTES;
  const origin = normalizeOrigin(options.publicOrigin);
  const secret = bridgeSecret(options.secret);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || !Number.isSafeInteger(hardTtlMs) || hardTtlMs < ttlMs || hardTtlMs > VIDEO_REFERENCE_BRIDGE_HARD_TTL_MS) throw new VideoReferenceBridgeError("INVALID_INPUT", "媒体租约时长无效");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > VIDEO_REFERENCE_BRIDGE_MAX_BYTES) throw new VideoReferenceBridgeError("INVALID_INPUT", "媒体大小限制无效");
  await ensureVideoReferenceBridgeSchema(db);
  await cleanupExpiredVideoReferenceLeases(db, now);
  const resolved = await resolveSource(db, source);
  const fingerprint = await fileFingerprint(options.rootDir, resolved.filePath, resolved.mediaType, maxBytes);
  const key = resourceKey(source, resolved.filePath, fingerprint);
  const requestedExpiry = now + ttlMs;
  return withResourceLock(db, key, async (conn) => {
    const candidates = await conn<any>("ext_video_reference_leases").where("resourceKey", "like", `${key}%`).orderBy("createdAt", "desc");
    const matching = candidates.map(rowFromDb).find((row) => row.contentHash === fingerprint.contentHash && row.sizeBytes === fingerprint.sizeBytes && Math.abs(row.mtimeMs - fingerprint.mtimeMs) <= 0.5 && row.revokedAt == null && row.expiresAt > now);
    if (matching && matching.hardExpiresAt >= requestedExpiry) {
      const expiry = Math.min(Math.max(matching.expiresAt, requestedExpiry), matching.hardExpiresAt);
      await conn("ext_video_reference_leases").where({ leaseId: matching.leaseId }).update({ expiresAt: expiry });
      return leaseResult(matching, source, origin, secret, expiry);
    }
    const leaseId = randomBytes(32).toString("base64url");
    const rowValues = {
      leaseId, leaseHash: hashLeaseId(leaseId), resourceKey: `${key}:${leaseId}`, projectId: source.projectId, scriptId: source.scriptId, sourceKind: source.sources, sourceId: source.id,
      filePath: resolved.filePath, mediaType: resolved.mediaType, sizeBytes: fingerprint.sizeBytes, mtimeMs: fingerprint.mtimeMs, contentHash: fingerprint.contentHash,
      createdAt: now, expiresAt: requestedExpiry, hardExpiresAt: now + hardTtlMs, revokedAt: null,
    };
    await conn("ext_video_reference_leases").insert(rowValues);
    return leaseResult(rowFromDb(rowValues), source, origin, secret, requestedExpiry);
  });
}

export async function lookupVideoReferenceLease(db: Knex, token: string, secret: string, now = Date.now()): Promise<VideoReferenceLeaseRow> {
  const leaseId = verifyVideoReferenceToken(token, secret);
  const row = await db<any>("ext_video_reference_leases").where({ leaseHash: hashLeaseId(leaseId) }).first();
  if (!row) throw new VideoReferenceBridgeError("NOT_FOUND", "媒体桥接租约不存在");
  const lease = rowFromDb(row);
  if (lease.revokedAt != null || lease.expiresAt <= now) throw new VideoReferenceBridgeError("NOT_FOUND", "媒体桥接租约已过期");
  await assertLeaseSourceStillOwned(db, lease);
  return lease;
}

export async function renewVideoReferenceLease(db: Knex, token: string, secret: string, ttlMs = VIDEO_REFERENCE_BRIDGE_TTL_MS, now = Date.now(), rootDir?: string): Promise<VideoReferenceLeaseRow> {
  const lease = await lookupVideoReferenceLease(db, token, secret, now);
  if (rootDir) {
    const fingerprint = await fileFingerprint(rootDir, lease.filePath, lease.mediaType, VIDEO_REFERENCE_BRIDGE_MAX_BYTES);
    if (fingerprint.contentHash !== lease.contentHash || fingerprint.sizeBytes !== lease.sizeBytes || Math.abs(fingerprint.mtimeMs - lease.mtimeMs) > 0.5) throw new VideoReferenceBridgeError("FILE_CHANGED", "参考素材已变更，不能续期原视频任务");
  }
  const expiry = Math.min(Math.max(lease.expiresAt, now + ttlMs), lease.hardExpiresAt);
  await db("ext_video_reference_leases").where({ leaseId: lease.leaseId }).update({ expiresAt: expiry });
  return { ...lease, expiresAt: expiry };
}

/** Refreshes bridge URLs in a persisted config without changing a valid token. */
export async function renewVideoReferenceConfigLeases(
  db: Knex,
  config: unknown,
  options: Omit<VideoReferenceLeaseOptions, "now">,
  now = Date.now(),
): Promise<unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const record = config as Record<string, unknown>;
  if (!Array.isArray(record.referenceList)) return config;
  let changed = false;
  const references = await Promise.all(record.referenceList.map(async (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const reference = value as Record<string, any>;
    const url = typeof reference.url === "string" ? reference.url : "";
    const match = url.match(/\/media-bridge\/([^/?#]+)$/);
    if (!match || !reference.source || typeof reference.source !== "object") return value;
    if (typeof reference.contentHash !== "string" || !Number.isSafeInteger(Number(reference.sizeBytes)) || !Number.isFinite(Number(reference.mtimeMs))) {
      throw new VideoReferenceBridgeError("FILE_CHANGED", "持久化参考素材缺少不可变文件快照，不能重签租约");
    }
    try {
      const lease = await renewVideoReferenceLease(db, match[1], options.secret, options.ttlMs ?? VIDEO_REFERENCE_BRIDGE_TTL_MS, now, options.rootDir);
      if (lease.contentHash !== reference.contentHash || lease.sizeBytes !== Number(reference.sizeBytes) || Math.abs(lease.mtimeMs - Number(reference.mtimeMs)) > 0.5) throw new VideoReferenceBridgeError("FILE_CHANGED", "参考素材已变更，不能重签原视频任务");
      changed = true;
      return { ...reference, url: url.slice(0, url.length - match[1].length) + tokenFor(lease.leaseId, options.secret), expiresAt: lease.expiresAt };
    } catch (error) {
      if (!(error instanceof VideoReferenceBridgeError) || !["NOT_FOUND", "NOT_CONFIGURED"].includes(error.code)) throw error;
      const source = reference.source as VideoReferenceSource;
      const lease = await issueVideoReferenceLease(db, source, { ...options, now });
      if (lease.contentHash !== reference.contentHash || lease.sizeBytes !== Number(reference.sizeBytes) || Math.abs(lease.mtimeMs - Number(reference.mtimeMs)) > 0.5) {
        await revokeVideoReferenceLease(db, lease.leaseId, now);
        throw new VideoReferenceBridgeError("FILE_CHANGED", "参考素材已变更，不能重签原视频任务");
      }
      changed = true;
      return { ...reference, url: lease.url, leaseId: lease.leaseId, expiresAt: lease.expiresAt, contentHash: lease.contentHash, sizeBytes: lease.sizeBytes, mtimeMs: lease.mtimeMs };
    }
  }));
  return changed ? { ...record, referenceList: references } : config;
}

export async function revokeVideoReferenceLease(db: Knex, leaseId: string, now = Date.now()): Promise<void> {
  if (typeof leaseId !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(leaseId)) throw new VideoReferenceBridgeError("INVALID_INPUT", "媒体租约 ID 无效");
  await db("ext_video_reference_leases").where({ leaseId }).update({ revokedAt: now, expiresAt: now });
}

export async function cleanupExpiredVideoReferenceLeases(db: Knex, now = Date.now()): Promise<number> {
  if (!(await db.schema.hasTable("ext_video_reference_leases"))) return 0;
  return Number(await db("ext_video_reference_leases").where("expiresAt", "<=", now).delete());
}

export { canonicalPath as canonicalVideoReferencePath };
