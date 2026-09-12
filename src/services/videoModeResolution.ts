import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { isPostgres, lockProjectTransaction } from "../lib/dbTransaction";
import { isSeedance2Model, resolveVideoReferenceMediaType } from "../lib/videoPromptReferences";
import { assertTrackWritable } from "./storyboardTrackIndependence";
import { readBoundAudioReferences } from "./roleAudioWorkspace";

const INTENTS = "ext_video_mode_intents";
const RECEIPTS = "ext_video_mode_intent_requests";
const SUBMISSION_CLAIMS = "ext_video_mode_submission_claims";
const purposes = ["first_frame", "last_frame", "identity_reference", "style_reference", "motion_reference", "audio_reference"] as const;
const purposeSchema = z.enum(purposes);
const referenceSchema = z.object({ id: z.number().int().positive(), sources: z.enum(["storyboard", "assets"]), fileType: z.enum(["image", "video", "audio"]).optional(), purpose: purposeSchema.optional() }).strict();
const modeSchema = z.union([z.string().min(1), z.array(z.unknown())]);

export type VideoReferencePurpose = typeof purposes[number];
export type VideoModeIntent = "auto" | string | unknown[];
export interface VideoModeReference { id: number; sources: "storyboard" | "assets"; fileType: "image" | "video" | "audio"; purpose: VideoReferencePurpose }
export interface VideoModeCapabilities { mode?: unknown[]; modelName?: string }
export interface VideoModeResolution {
  trackId: number;
  modeIntent: VideoModeIntent;
  modeIntentRevision: number;
  resolvedMode: unknown;
  resolvedReferences: VideoModeReference[];
  referenceSummary: { total: number; image: number; video: number; audio: number; purposes: Record<VideoReferencePurpose, number> };
  compatibility: { ok: true };
}

export class VideoModeResolutionError extends Error {
  constructor(public readonly code: "VIDEO_MODE_INCOMPATIBLE" | "REFERENCE_UNAVAILABLE" | "MODE_INTENT_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "PROJECT_MISMATCH" | "INVALID_INPUT" | "MIGRATION_REQUIRED" | "ARCHIVED_TRACK", message: string, public readonly status = 400) { super(message); this.name = "VideoModeResolutionError"; }
}

function hash(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`; return JSON.stringify(value); }
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } }
function normalizeIntent(value: unknown): VideoModeIntent {
  const parsed = parseJson(value);
  if (parsed === "auto") return "auto";
  if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
  if (Array.isArray(parsed)) return parsed;
  throw new VideoModeResolutionError("INVALID_INPUT", "视频生成方式无效");
}
function sameMode(left: unknown, right: unknown): boolean { return stable(parseJson(left)) === stable(parseJson(right)); }
function capacity(mode: unknown): Record<"image" | "video" | "audio", number> | null {
  if (!Array.isArray(mode)) return null;
  const result = { image: 0, video: 0, audio: 0 };
  for (const item of mode) {
    const match = String(item).match(/^(image|video|audio)Reference:(\d+)$/i);
    if (!match) continue;
    const type = match[1].toLowerCase() as keyof typeof result, limit = Number(match[2]);
    if (!Number.isSafeInteger(limit) || limit < 0) return null;
    result[type] = Math.max(result[type], limit);
  }
  return result;
}
function supportsAll(mode: unknown, references: VideoModeReference[]): boolean {
  const parsed = parseJson(mode), types = references.map((item) => item.fileType);
  if (parsed === "text") return references.length === 0;
  if (Array.isArray(parsed)) { const limits = capacity(parsed); return Boolean(limits) && (["image", "video", "audio"] as const).every((type) => types.filter((item) => item === type).length <= limits![type]); }
  if (types.some((type) => type !== "image")) return false;
  const first = references.filter((item) => item.purpose === "first_frame"), last = references.filter((item) => item.purpose === "last_frame");
  if (references.some((item) => !["first_frame", "last_frame"].includes(item.purpose))) return false;
  if (parsed === "singleImage") return references.length === 1 && first.length === 1;
  if (parsed === "startEndRequired") return references.length === 2 && first.length === 1 && last.length === 1;
  if (parsed === "endFrameOptional") return first.length === 1 && last.length <= 1 && references.length === first.length + last.length;
  if (parsed === "startFrameOptional") return last.length === 1 && first.length <= 1 && references.length === first.length + last.length;
  return false;
}
function orderForMode(mode: unknown, references: VideoModeReference[]): VideoModeReference[] {
  if (Array.isArray(parseJson(mode))) return references;
  return [...references].sort((left, right) => (["first_frame", "last_frame"].indexOf(left.purpose) - ["first_frame", "last_frame"].indexOf(right.purpose)));
}
function chooseAutomaticMode(supported: unknown[], references: VideoModeReference[]): unknown {
  if (!references.length) {
    const text = supported.find((mode) => sameMode(mode, "text"));
    if (text === undefined) throw new VideoModeResolutionError("VIDEO_MODE_INCOMPATIBLE", "当前片段没有可用素材，所选模型又不支持文生视频");
    return parseJson(text);
  }
  const semantic = references.some((item) => !["first_frame", "last_frame"].includes(item.purpose));
  if (semantic) {
    const multi = supported.find((mode) => Array.isArray(parseJson(mode)) && supportsAll(mode, references));
    if (multi === undefined) throw new VideoModeResolutionError("VIDEO_MODE_INCOMPATIBLE", "当前模型的多模态参考能力无法容纳本片段全部角色、场景、道具、视频或音频素材；未降级为文生视频");
    return parseJson(multi);
  }
  const first = references.some((item) => item.purpose === "first_frame"), last = references.some((item) => item.purpose === "last_frame");
  const preferred = first && last ? ["startEndRequired", "endFrameOptional", "startFrameOptional"] : first ? ["singleImage", "endFrameOptional"] : last ? ["startFrameOptional"] : [];
  for (const name of preferred) { const found = supported.find((mode) => sameMode(mode, name) && supportsAll(mode, references)); if (found !== undefined) return parseJson(found); }
  throw new VideoModeResolutionError("VIDEO_MODE_INCOMPATIBLE", "当前模型不支持本片段明确选择的首帧或首尾帧素材；未丢弃素材或降级为文生视频");
}

export function resolveVideoMode(input: { trackId: number; modeIntent: unknown; modeIntentRevision?: number; capabilities: VideoModeCapabilities; references: VideoModeReference[] }): VideoModeResolution {
  const modeIntent = normalizeIntent(input.modeIntent), supported = Array.isArray(input.capabilities.mode) ? input.capabilities.mode : [];
  if (!supported.length) throw new VideoModeResolutionError("VIDEO_MODE_INCOMPATIBLE", "所选模型没有声明视频生成方式能力");
  if (input.references.length > 0 && input.references.every((reference) => reference.fileType === "audio") && isSeedance2Model(input.capabilities.modelName)) throw new VideoModeResolutionError("VIDEO_MODE_INCOMPATIBLE", "Seedance 2.x 不支持仅输入音频参考；请增加图片或视频参考，素材不会被丢弃");
  let resolvedMode: unknown;
  if (modeIntent === "auto") resolvedMode = chooseAutomaticMode(supported, input.references);
  else {
    const declared = supported.find((mode) => sameMode(mode, modeIntent));
    if (declared === undefined) throw new VideoModeResolutionError("VIDEO_MODE_INCOMPATIBLE", "人工选择的视频生成方式不受当前模型支持，请重新选择；素材与人工提示词均已保留");
    resolvedMode = parseJson(declared);
    if (!supportsAll(resolvedMode, input.references)) throw new VideoModeResolutionError("VIDEO_MODE_INCOMPATIBLE", "人工选择的视频生成方式无法使用本片段全部素材；未丢弃素材或降级为文生视频");
  }
  const resolvedReferences = orderForMode(resolvedMode, input.references);
  const purposeCounts = Object.fromEntries(purposes.map((purpose) => [purpose, resolvedReferences.filter((item) => item.purpose === purpose).length])) as Record<VideoReferencePurpose, number>;
  return { trackId: input.trackId, modeIntent, modeIntentRevision: input.modeIntentRevision ?? 0, resolvedMode, resolvedReferences,
    referenceSummary: { total: resolvedReferences.length, image: resolvedReferences.filter((item) => item.fileType === "image").length, video: resolvedReferences.filter((item) => item.fileType === "video").length, audio: resolvedReferences.filter((item) => item.fileType === "audio").length, purposes: purposeCounts }, compatibility: { ok: true } };
}

export async function resolveVideoReferencePurposes(db: Knex | Knex.Transaction, input: { projectId: number; scriptId: number; trackId: number; references: unknown }): Promise<VideoModeReference[]> {
  const references = z.array(referenceSchema).max(100).parse(input.references), unique = new Map<string, typeof references[number]>();
  for (const reference of references) { const key = `${reference.sources}:${reference.id}`; const old = unique.get(key); if (old && old.purpose !== reference.purpose) throw new VideoModeResolutionError("INVALID_INPUT", "同一视频素材不能声明两个不同用途"); unique.set(key, reference); }
  const values = [...unique.values()], boardIds = values.filter((item) => item.sources === "storyboard").map((item) => item.id), assetIds = values.filter((item) => item.sources === "assets").map((item) => item.id);
  const boards = boardIds.length ? await db("o_storyboard").where({ projectId: input.projectId, scriptId: input.scriptId }).whereIn("id", boardIds).select("id", "trackId", "index", "filePath") : [];
  const assets = assetIds.length ? await db("o_assets as asset").join("o_scriptAssets as scriptAsset", "scriptAsset.assetId", "asset.id").leftJoin("o_image as image", "image.id", "asset.imageId")
    .where({ "asset.projectId": input.projectId, "scriptAsset.scriptId": input.scriptId }).whereIn("asset.id", assetIds).select("asset.id", "asset.type", "image.type as storedFileType", "image.filePath") : [];
  const boardMap = new Map(boards.map((row) => [Number(row.id), row])), assetMap = new Map(assets.map((row) => [Number(row.id), row]));
  const selectedBoards = values.filter((item) => item.sources === "storyboard").map((item) => boardMap.get(item.id)).filter(Boolean).sort((a: any, b: any) => Number(a.index) - Number(b.index) || Number(a.id) - Number(b.id));
  return values.map((reference) => {
    const row = reference.sources === "storyboard" ? boardMap.get(reference.id) : assetMap.get(reference.id);
    if (!row?.filePath) throw new VideoModeResolutionError("REFERENCE_UNAVAILABLE", `所选${reference.sources === "storyboard" ? "分镜" : "素材"} ${reference.id} 已删除、换轨、未关联当前剧集或没有当前媒体，不能自动改成文生视频`);
    const actualType = reference.sources === "storyboard" ? "image" as const : resolveVideoReferenceMediaType(row.storedFileType, row.type, row.filePath);
    if (reference.fileType && reference.fileType !== actualType) throw new VideoModeResolutionError("REFERENCE_UNAVAILABLE", `所选素材 ${reference.id} 的媒体类型已变化，请重新核对`);
    let purpose = reference.purpose;
    if (!purpose && actualType === "video") purpose = "motion_reference";
    else if (!purpose && actualType === "audio") purpose = "audio_reference";
    else if (!purpose && reference.sources === "assets") purpose = row.type === "role" ? "identity_reference" : "style_reference";
    else if (!purpose) purpose = selectedBoards.length === 1 ? "first_frame" : "style_reference";
    if (["first_frame", "last_frame", "identity_reference", "style_reference"].includes(purpose!) && actualType !== "image") throw new VideoModeResolutionError("INVALID_INPUT", `${purpose} 用途必须选择图片`);
    if (purpose === "motion_reference" && actualType !== "video") throw new VideoModeResolutionError("INVALID_INPUT", "motion_reference 用途必须选择视频");
    if (purpose === "audio_reference" && actualType !== "audio") throw new VideoModeResolutionError("INVALID_INPUT", "audio_reference 用途必须选择音频");
    return { id: reference.id, sources: reference.sources, fileType: actualType, purpose: purpose! };
  });
}

export interface StoredVideoModeSelection { trackId: number; modeIntent: VideoModeIntent; references: Array<z.infer<typeof referenceSchema>>; referencesInitialized: boolean; referenceSourceSnapshot: unknown[]; promptReferenceRevision: number; revision: number; source: "track" | "default" }

export async function ensureVideoModeIntentSchema(db: Knex): Promise<void> {
  await db.transaction(async (trx) => {
    if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", ["toonflow:video-mode-intents"]);
    const fresh = !(await trx.schema.hasTable(INTENTS));
    if (fresh) await trx.schema.createTable(INTENTS, (table) => { table.bigInteger("projectId"); table.bigInteger("scriptId"); table.bigInteger("trackId"); table.integer("revision").notNullable(); table.text("modeIntent").notNullable(); table.text("references").notNullable().defaultTo("[]"); table.boolean("referencesInitialized").notNullable().defaultTo(false); table.text("referenceSourceSnapshot").notNullable().defaultTo("[]"); table.integer("promptReferenceRevision").notNullable().defaultTo(0); table.text("updatedBy").notNullable(); table.bigInteger("updatedAt").notNullable(); table.primary(["projectId", "trackId"]); table.index(["projectId", "scriptId"]); });
    else {
      if (!(await trx.schema.hasColumn(INTENTS, "references"))) await trx.schema.alterTable(INTENTS, (table) => table.text("references").notNullable().defaultTo("[]"));
      if (!(await trx.schema.hasColumn(INTENTS, "referencesInitialized"))) await trx.schema.alterTable(INTENTS, (table) => table.boolean("referencesInitialized").notNullable().defaultTo(false));
      if (!(await trx.schema.hasColumn(INTENTS, "promptReferenceRevision"))) await trx.schema.alterTable(INTENTS, (table) => table.integer("promptReferenceRevision").notNullable().defaultTo(0));
      if (!(await trx.schema.hasColumn(INTENTS, "referenceSourceSnapshot"))) await trx.schema.alterTable(INTENTS, (table) => table.text("referenceSourceSnapshot").notNullable().defaultTo("[]"));
    }
    if (!(await trx.schema.hasTable(RECEIPTS))) await trx.schema.createTable(RECEIPTS, (table) => { table.text("actorId"); table.bigInteger("projectId"); table.text("idempotencyKey"); table.text("requestHash"); table.text("result"); table.bigInteger("createdAt"); table.primary(["actorId", "projectId", "idempotencyKey"]); });
    if (!(await trx.schema.hasTable(SUBMISSION_CLAIMS))) await trx.schema.createTable(SUBMISSION_CLAIMS, (table) => { table.bigInteger("jobId").primary(); table.bigInteger("projectId").notNullable(); table.bigInteger("scriptId").notNullable(); table.bigInteger("trackId").notNullable(); table.integer("selectionRevision").notNullable(); table.text("snapshotHash").notNullable(); table.bigInteger("claimedAt").notNullable(); table.index(["projectId", "trackId"]); });
    // Project.mode remains a legacy-client default. It is not evidence that a
    // person selected a mode for each track, so no per-track rows are backfilled.
  });
}

export async function readVideoModeIntent(db: Knex | Knex.Transaction, input: { projectId: number; scriptId: number; trackId: number }): Promise<StoredVideoModeSelection> {
  if (!(await db.schema.hasTable(INTENTS))) return { trackId: input.trackId, modeIntent: "auto", references: [], referencesInitialized: false, referenceSourceSnapshot: [], promptReferenceRevision: 0, revision: 0, source: "default" };
  const row = await db(INTENTS).where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId }).first();
  return row ? { trackId: input.trackId, modeIntent: normalizeIntent(row.modeIntent), references: z.array(referenceSchema).parse(parseJson(row.references ?? "[]")), referencesInitialized: Boolean(row.referencesInitialized), referenceSourceSnapshot: Array.isArray(parseJson(row.referenceSourceSnapshot ?? "[]")) ? parseJson(row.referenceSourceSnapshot ?? "[]") as unknown[] : [], promptReferenceRevision: Number(row.promptReferenceRevision ?? 0), revision: Number(row.revision), source: "track" } : { trackId: input.trackId, modeIntent: "auto", references: [], referencesInitialized: false, referenceSourceSnapshot: [], promptReferenceRevision: 0, revision: 0, source: "default" };
}

export async function saveVideoModeIntent(db: Knex, raw: unknown, actorId: string) {
  await ensureVideoModeIntentSchema(db);
  const input = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(), trackId: z.number().int().positive(), modeIntent: modeSchema, expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(150).regex(/^[\w:.-]+$/) }).strict().parse(raw);
  const modeIntent = normalizeIntent(input.modeIntent), requestHash = hash({ ...input, modeIntent }), receiptKey = { actorId, projectId: input.projectId, idempotencyKey: input.idempotencyKey };
  const replay = await db(RECEIPTS).where(receiptKey).first(); if (replay) { if (replay.requestHash !== requestHash) throw new VideoModeResolutionError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同视频生成方式", 409); return { ...JSON.parse(replay.result), reused: true }; }
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const old = await trx(RECEIPTS).where(receiptKey).first(); if (old) { if (old.requestHash !== requestHash) throw new VideoModeResolutionError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同视频生成方式", 409); return { ...JSON.parse(old.result), reused: true }; }
    const track = await trx("o_videoTrack").where({ id: input.trackId, projectId: input.projectId, scriptId: input.scriptId }).first(); if (!track) throw new VideoModeResolutionError("PROJECT_MISMATCH", "视频片段不属于当前项目或剧集", 403);
    await assertTrackWritable(trx, input.projectId, input.trackId).catch(() => { throw new VideoModeResolutionError("ARCHIVED_TRACK", "历史共享轨道只能查看", 409); });
    const current = await trx(INTENTS).where({ projectId: input.projectId, trackId: input.trackId }).forUpdate().first(); if (Number(current?.revision ?? 0) !== input.expectedRevision) throw new VideoModeResolutionError("MODE_INTENT_CONFLICT", "视频生成方式已被修改，请刷新", 409);
    const references = current ? z.array(referenceSchema).parse(parseJson(current.references ?? "[]")) : [], referencesInitialized = Boolean(current?.referencesInitialized), referenceSourceSnapshot = current ? parseJson(current.referenceSourceSnapshot ?? "[]") : [];
    const promptReferenceRevision = Number(current?.promptReferenceRevision ?? 0), result = { trackId: input.trackId, modeIntent, references, referencesInitialized, promptReferenceRevision, revision: input.expectedRevision + 1 };
    await trx(INTENTS).insert({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, revision: result.revision, modeIntent: JSON.stringify(modeIntent), references: JSON.stringify(references), referencesInitialized, referenceSourceSnapshot: JSON.stringify(referenceSourceSnapshot), promptReferenceRevision, updatedBy: actorId, updatedAt: Date.now() }).onConflict(["projectId", "trackId"]).merge();
    await trx(RECEIPTS).insert({ ...receiptKey, requestHash, result: JSON.stringify(result), createdAt: Date.now() }); return { ...result, reused: false };
  });
}

export async function saveVideoReferences(db: Knex, raw: unknown, actorId: string, hashSource?: (filePath: string) => Promise<string>) {
  await ensureVideoModeIntentSchema(db);
  const input = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(), trackId: z.number().int().positive(), references: z.array(referenceSchema).max(100), expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(150).regex(/^[\w:.-]+$/) }).strict().parse(raw);
  const requestHash = hash(input), receiptKey = { actorId, projectId: input.projectId, idempotencyKey: input.idempotencyKey };
  const replay = await db(RECEIPTS).where(receiptKey).first(); if (replay) { if (replay.requestHash !== requestHash) throw new VideoModeResolutionError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同视频参考素材", 409); return { ...JSON.parse(replay.result), reused: true }; }
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const old = await trx(RECEIPTS).where(receiptKey).first(); if (old) { if (old.requestHash !== requestHash) throw new VideoModeResolutionError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同视频参考素材", 409); return { ...JSON.parse(old.result), reused: true }; }
    const track = await trx("o_videoTrack").where({ id: input.trackId, projectId: input.projectId, scriptId: input.scriptId }).first(); if (!track) throw new VideoModeResolutionError("PROJECT_MISMATCH", "视频片段不属于当前项目或剧集", 403);
    await assertTrackWritable(trx, input.projectId, input.trackId).catch(() => { throw new VideoModeResolutionError("ARCHIVED_TRACK", "历史共享轨道只能查看", 409); });
    const current = await trx(INTENTS).where({ projectId: input.projectId, trackId: input.trackId }).forUpdate().first(); if (Number(current?.revision ?? 0) !== input.expectedRevision) throw new VideoModeResolutionError("MODE_INTENT_CONFLICT", "视频生成方式或参考素材已被修改，请刷新", 409);
    const references = await resolveVideoReferencePurposes(trx, { ...input, references: input.references });
    const referenceSourceSnapshot = await captureReferenceSources(trx, { ...input, references }, hashSource);
    const modeIntent = current ? normalizeIntent(current.modeIntent) : "auto", promptReferenceRevision = Number(current?.promptReferenceRevision ?? 0), result = { trackId: input.trackId, modeIntent, references, referencesInitialized: true, promptReferenceRevision, revision: input.expectedRevision + 1 };
    await trx(INTENTS).insert({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, revision: result.revision, modeIntent: JSON.stringify(modeIntent), references: JSON.stringify(references), referencesInitialized: true, referenceSourceSnapshot: JSON.stringify(referenceSourceSnapshot), promptReferenceRevision, updatedBy: actorId, updatedAt: Date.now() }).onConflict(["projectId", "trackId"]).merge();
    await trx(RECEIPTS).insert({ ...receiptKey, requestHash, result: JSON.stringify(result), createdAt: Date.now() }); return { ...result, reused: false };
  });
}

export async function reloadStoryboardTrackReferences(db: Knex, raw: unknown, actorId: string, hashSource?: (filePath: string) => Promise<string>) {
  await ensureVideoModeIntentSchema(db);
  const input = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(), trackId: z.number().int().positive(), storyboardId: z.number().int().positive(), expectedTrackVersion: z.number().int().nonnegative(), expectedStoryboardVersion: z.number().int().nonnegative(), expectedModeIntentRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(150).regex(/^[\w:.-]+$/) }).strict().parse(raw);
  const requestHash = hash({ operation: "reloadStoryboardTrackReferences", ...input }), receiptKey = { actorId, projectId: input.projectId, idempotencyKey: input.idempotencyKey };
  const replay = await db(RECEIPTS).where(receiptKey).first(); if (replay) { if (replay.requestHash !== requestHash) throw new VideoModeResolutionError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同重新载入请求", 409); return { ...JSON.parse(replay.result), reused: true }; }
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId); const oldReceipt = await trx(RECEIPTS).where(receiptKey).first(); if (oldReceipt) { if (oldReceipt.requestHash !== requestHash) throw new VideoModeResolutionError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同重新载入请求", 409); return { ...JSON.parse(oldReceipt.result), reused: true }; }
    const track = await trx("o_videoTrack").where({ id: input.trackId, projectId: input.projectId, scriptId: input.scriptId }).first(); if (!track) throw new VideoModeResolutionError("PROJECT_MISMATCH", "视频片段不属于当前项目或剧集", 403);
    await assertTrackWritable(trx, input.projectId, input.trackId).catch(() => { throw new VideoModeResolutionError("ARCHIVED_TRACK", "历史共享轨道只能查看", 409); });
    const boards = await trx("o_storyboard").where({ trackId: input.trackId }).orderBy("id");
    if (boards.some((board) => Number(board.projectId) !== input.projectId || Number(board.scriptId) !== input.scriptId)) throw new VideoModeResolutionError("PROJECT_MISMATCH", "轨道存在跨项目或跨剧集分镜引用", 403);
    if (boards.length !== 1 || Number(boards[0].id) !== input.storyboardId) throw new VideoModeResolutionError("MIGRATION_REQUIRED", "重新载入仅支持已独立的一镜一片段", 409);
    const trackVersion = await trx.schema.hasTable("ext_creative_state") ? Number((await trx("ext_creative_state").where({ projectId: input.projectId, entityType: "track", entityId: input.trackId }).first("version"))?.version ?? 0) : 0;
    const boardState = await trx("ext_entity_state").where({ projectId: input.projectId, entityType: "storyboard", entityId: input.storyboardId }).first();
    if (trackVersion !== input.expectedTrackVersion || Number(boardState?.version ?? 0) !== input.expectedStoryboardVersion) throw new VideoModeResolutionError("MODE_INTENT_CONFLICT", "分镜或片段已变化，请刷新后重新载入", 409);
    if (boardState?.locked) throw new VideoModeResolutionError("MODE_INTENT_CONFLICT", "锁定分镜不能重新载入视频参考", 423);
    if (await trx.schema.hasTable("ext_video_prompt_jobs") && await trx("ext_video_prompt_jobs").where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId }).whereIn("state", ["queued", "running"]).first()) throw new VideoModeResolutionError("MODE_INTENT_CONFLICT", "视频提示词仍在生成，不能替换参考素材", 409);
    const current = await trx(INTENTS).where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId }).forUpdate().first();
    if (Number(current?.revision ?? 0) !== input.expectedModeIntentRevision) throw new VideoModeResolutionError("MODE_INTENT_CONFLICT", "视频生成方式或参考素材已变化，请刷新", 409);
    const linked = await trx("o_assets2Storyboard as link").join("o_assets as asset", "asset.id", "link.assetId").leftJoin("o_image as image", "image.id", "asset.imageId").where({ "link.storyboardId": input.storyboardId, "asset.projectId": input.projectId }).orderBy("link.id").select("asset.id", "asset.assetsId", "asset.type", "image.type as storedFileType", "image.filePath");
    const visual = linked.filter((row) => row.filePath).map((row) => { const fileType = resolveVideoReferenceMediaType(row.storedFileType, row.type, row.filePath); return { id: Number(row.id), sources: "assets" as const, fileType, purpose: fileType === "video" ? "motion_reference" as const : fileType === "audio" ? "audio_reference" as const : row.type === "role" ? "identity_reference" as const : "style_reference" as const }; });
    const roleIds = [...new Set(linked.filter((row) => row.type === "role").flatMap((row) => [Number(row.id), Number(row.assetsId)]).filter((id) => Number.isSafeInteger(id) && id > 0))];
    const audio = roleIds.length ? await readBoundAudioReferences(trx as unknown as Knex, input.projectId, roleIds) : [];
    const nextReferences = [...(boards[0].filePath ? [{ id: input.storyboardId, sources: "storyboard" as const, fileType: "image" as const, purpose: "first_frame" as const }] : []), ...visual, ...audio.map((row) => ({ id: row.id, sources: "assets" as const, fileType: "audio" as const, purpose: "audio_reference" as const }))];
    const references = [...new Map(nextReferences.map((reference) => [`${reference.sources}:${reference.id}`, reference])).values()];
    const referenceSourceSnapshot = await captureReferenceSources(trx, { ...input, references }, hashSource), previous = current ? z.array(referenceSchema).parse(parseJson(current.references ?? "[]")) : [], previousSources = current ? parseJson(current.referenceSourceSnapshot ?? "[]") : [];
    const changed = !Boolean(current?.referencesInitialized) || stable(previous) !== stable(references) || stable(previousSources) !== stable(referenceSourceSnapshot), revision = input.expectedModeIntentRevision + (changed ? 1 : 0);
    const modeIntent = current ? normalizeIntent(current.modeIntent) : "auto", promptReferenceRevision = Number(current?.promptReferenceRevision ?? 0);
    if (changed) await trx(INTENTS).insert({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, revision, modeIntent: JSON.stringify(modeIntent), references: JSON.stringify(references), referencesInitialized: true, referenceSourceSnapshot: JSON.stringify(referenceSourceSnapshot), promptReferenceRevision, updatedBy: actorId, updatedAt: Date.now() }).onConflict(["projectId", "trackId"]).merge();
    const result = { trackId: input.trackId, storyboardId: input.storyboardId, modeIntent, references, referencesInitialized: true, revision, promptReferenceRevision, changed, needsReview: changed && Boolean(String(track.prompt ?? "").trim()) && promptReferenceRevision !== revision };
    await trx(RECEIPTS).insert({ ...receiptKey, requestHash, result: JSON.stringify(result), createdAt: Date.now() }); return { ...result, reused: false };
  });
}

export async function acknowledgeVideoPromptReferences(db: Knex | Knex.Transaction, input: { projectId: number; scriptId: number; trackId: number; expectedRevision?: number }, actorId: string): Promise<number | null> {
  const row = await db(INTENTS).where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId }).first();
  if (!row) {
    if (input.expectedRevision === undefined) return null;
    if (input.expectedRevision !== 0) throw new VideoModeResolutionError("MODE_INTENT_CONFLICT", "视频参考素材已变化，请刷新提示词后再保存", 409);
    await db(INTENTS).insert({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, revision: 0, modeIntent: JSON.stringify("auto"), references: "[]", referencesInitialized: false, referenceSourceSnapshot: "[]", promptReferenceRevision: 0, updatedBy: actorId, updatedAt: Date.now() });
    return 0;
  }
  const revision = Number(row.revision);
  if (input.expectedRevision === undefined) return Number(row.promptReferenceRevision ?? 0);
  if (input.expectedRevision !== revision) throw new VideoModeResolutionError("MODE_INTENT_CONFLICT", "视频参考素材已变化，请核对当前素材后再保存提示词", 409);
  await db(INTENTS).where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, revision }).update({ promptReferenceRevision: revision, updatedBy: actorId, updatedAt: Date.now() });
  return revision;
}

export async function resolveStoredVideoMode(db: Knex, input: { projectId: number; scriptId: number; trackId: number; model: string; capabilities: VideoModeCapabilities; references: unknown; expectedIntentRevision?: number; legacyMode?: unknown }): Promise<VideoModeResolution> {
  await ensureVideoModeIntentSchema(db);
  if (!(await db("o_videoTrack").where({ id: input.trackId, projectId: input.projectId, scriptId: input.scriptId }).first("id"))) throw new VideoModeResolutionError("PROJECT_MISMATCH", "视频片段不属于当前项目或剧集", 403);
  await assertTrackWritable(db, input.projectId, input.trackId).catch(() => { throw new VideoModeResolutionError("ARCHIVED_TRACK", "历史共享轨道只能查看", 409); });
  if (Number((await db("o_storyboard").where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId }).count("id as count").first())?.count ?? 0) > 1) throw new VideoModeResolutionError("MIGRATION_REQUIRED", "该历史片段仍包含多条分镜，请先完成一镜一片段迁移", 409);
  const saved = await readVideoModeIntent(db, input);
  if (input.expectedIntentRevision !== undefined && input.expectedIntentRevision !== saved.revision) throw new VideoModeResolutionError("MODE_INTENT_CONFLICT", "视频生成方式已变化，请刷新", 409);
  const modeIntent = saved.source === "default" && input.expectedIntentRevision === undefined && input.legacyMode !== undefined ? normalizeIntent(input.legacyMode) : saved.modeIntent;
  const requested = z.array(referenceSchema).parse(input.references);
  if (saved.referencesInitialized && stable(saved.references) !== stable(requested)) throw new VideoModeResolutionError("MODE_INTENT_CONFLICT", "视频参考素材或用途已变化，请刷新", 409);
  const references = await resolveVideoReferencePurposes(db, { ...input, references: saved.referencesInitialized ? saved.references : requested });
  return resolveVideoMode({ trackId: input.trackId, modeIntent, modeIntentRevision: saved.revision, capabilities: input.capabilities, references });
}

export interface VideoModeSelectionSnapshot { modeIntent: VideoModeIntent; revision: number; resolvedMode: unknown; references: VideoModeReference[]; referenceSources: Array<{ id: number; sources: "storyboard" | "assets"; identityHash: string; contentHash: string }> }
async function captureReferenceSources(db: Knex | Knex.Transaction, input: { projectId: number; scriptId: number; trackId: number; references: VideoModeReference[] }, hashSource?: (filePath: string) => Promise<string>) {
  return Promise.all(input.references.map(async (reference) => {
    let row: any, version = 0;
    if (reference.sources === "storyboard") {
      row = await db("o_storyboard").where({ id: reference.id, projectId: input.projectId, scriptId: input.scriptId }).first("id", "trackId", "filePath");
      version = await db.schema.hasTable("ext_entity_state") ? Number((await db("ext_entity_state").where({ projectId: input.projectId, entityType: "storyboard", entityId: reference.id }).first("version"))?.version ?? 0) : 0;
    } else {
      row = await db("o_assets as asset").join("o_scriptAssets as scriptAsset", "scriptAsset.assetId", "asset.id").leftJoin("o_image as image", "image.id", "asset.imageId")
        .where({ "asset.id": reference.id, "asset.projectId": input.projectId, "scriptAsset.scriptId": input.scriptId }).first("asset.id", "asset.imageId", "image.filePath");
      version = await db.schema.hasTable("ext_creative_state") ? Number((await db("ext_creative_state").where({ projectId: input.projectId, entityType: "asset", entityId: reference.id }).first("version"))?.version ?? 0) : 0;
    }
    if (!row?.filePath) throw new VideoModeResolutionError("REFERENCE_UNAVAILABLE", `视频参考素材 ${reference.id} 已变化或没有当前媒体`);
    const identityHash = hash({ filePath: String(row.filePath), imageId: row.imageId == null ? null : Number(row.imageId), sourceTrackId: row.trackId == null ? null : Number(row.trackId), version, fileType: reference.fileType });
    if (!hashSource) return { id: reference.id, sources: reference.sources, identityHash };
    let contentHash: string;
    try {
      const content = await hashSource(String(row.filePath)), match = content.match(/^data:[^;,]+;base64,([A-Za-z0-9+/=\r\n]+)$/);
      contentHash = createHash("sha256").update(match ? Buffer.from(match[1].replace(/\s/g, ""), "base64") : content).digest("hex");
    } catch { throw new VideoModeResolutionError("REFERENCE_UNAVAILABLE", `无法读取视频参考素材 ${reference.id} 的当前内容`); }
    return { id: reference.id, sources: reference.sources, identityHash, contentHash };
  }));
}
export async function captureVideoModeSelectionSnapshot(db: Knex, input: { projectId: number; scriptId: number; trackId: number; resolution: VideoModeResolution }, hashSource: (filePath: string) => Promise<string>): Promise<VideoModeSelectionSnapshot> {
  const referenceSources = await captureReferenceSources(db, { ...input, references: input.resolution.resolvedReferences }, hashSource) as VideoModeSelectionSnapshot["referenceSources"];
  return { modeIntent: input.resolution.modeIntent, revision: input.resolution.modeIntentRevision, resolvedMode: input.resolution.resolvedMode, references: input.resolution.resolvedReferences, referenceSources };
}

/** The durable claim defines the final selection for this paid submission. Selection edits committed after this project-locked point apply to the next generation. */
export async function claimVideoModeSelectionForSubmission(db: Knex, input: { jobId: number; projectId: number; scriptId: number; trackId: number; snapshot: VideoModeSelectionSnapshot }, hashSource: (filePath: string) => Promise<string>): Promise<void> {
  try {
    await revalidateVideoModeSelection(db, input, hashSource);
    await ensureVideoModeIntentSchema(db);
    await db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const current = await readVideoModeIntent(trx, input), references = current.referencesInitialized ? await resolveVideoReferencePurposes(trx, { ...input, references: current.references }) : input.snapshot.references;
    const ordered = orderForMode(input.snapshot.resolvedMode, references);
    const identities = await captureReferenceSources(trx, { ...input, references: ordered });
    const expectedIdentities = input.snapshot.referenceSources.map(({ contentHash: _contentHash, ...item }) => item);
    if (current.revision !== input.snapshot.revision || stable(current.modeIntent) !== stable(input.snapshot.modeIntent) || stable(ordered) !== stable(input.snapshot.references) || stable(identities) !== stable(expectedIdentities)) {
      throw Object.assign(new VideoModeResolutionError("MODE_INTENT_CONFLICT", "最终提交前视频生成方式或参考素材已变化，本次旧请求未提交", 409), { submissionOutcome: "not_submitted" });
    }
    const snapshotHash = hash(input.snapshot), existing = await trx(SUBMISSION_CLAIMS).where({ jobId: input.jobId }).first();
    if (existing) { if (existing.snapshotHash !== snapshotHash) throw Object.assign(new VideoModeResolutionError("MODE_INTENT_CONFLICT", "视频任务已声明另一份参考快照", 409), { submissionOutcome: "not_submitted" }); return; }
    await trx(SUBMISSION_CLAIMS).insert({ jobId: input.jobId, projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, selectionRevision: input.snapshot.revision, snapshotHash, claimedAt: Date.now() });
    });
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new VideoModeResolutionError("REFERENCE_UNAVAILABLE", "最终视频参考核验失败"), { submissionOutcome: "not_submitted" });
  }
}
export async function revalidateVideoModeSelection(db: Knex, input: { projectId: number; scriptId: number; trackId: number; snapshot: VideoModeSelectionSnapshot }, hashSource: (filePath: string) => Promise<string>): Promise<void> {
  try {
    const current = await readVideoModeIntent(db, input);
    const expected = input.snapshot;
    const actualReferences = current.referencesInitialized ? await resolveVideoReferencePurposes(db, { ...input, references: current.references }) : expected.references;
    const resolution: VideoModeResolution = { trackId: input.trackId, modeIntent: current.modeIntent, modeIntentRevision: current.revision, resolvedMode: expected.resolvedMode, resolvedReferences: orderForMode(expected.resolvedMode, actualReferences), referenceSummary: { total: 0, image: 0, video: 0, audio: 0, purposes: Object.fromEntries(purposes.map((purpose) => [purpose, 0])) as Record<VideoReferencePurpose, number> }, compatibility: { ok: true } };
    const actual = await captureVideoModeSelectionSnapshot(db, { ...input, resolution }, hashSource);
    if (stable(actual) !== stable(expected)) throw new VideoModeResolutionError("MODE_INTENT_CONFLICT", "视频生成方式、参考素材或用途已变化，本次旧请求未提交", 409);
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new VideoModeResolutionError("REFERENCE_UNAVAILABLE", "视频参考素材核验失败"), { submissionOutcome: "not_submitted" });
  }
}
