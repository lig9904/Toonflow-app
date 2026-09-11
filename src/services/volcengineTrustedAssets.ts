import { createHash, createHmac } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { isPostgres, lockProjectTransaction } from "../lib/dbTransaction";
import { resolveVideoReferenceMediaType } from "../lib/videoPromptReferences";

const HOST = "ark.cn-beijing.volcengineapi.com";
const ENDPOINT = `https://${HOST}/`;
const API_VERSION = "2024-01-01";
const REGION = "cn-beijing";
const SERVICE = "ark";
const SETS = "ext_volcengine_reference_sets";
const ITEMS = "ext_volcengine_references";
const RECEIPTS = "ext_volcengine_reference_requests";
const groupType = z.enum(["AIGC", "LivenessFace"]);
const assetType = z.enum(["Image", "Video", "Audio"]);
const remoteId = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const projectName = z.string().trim().min(1).max(128).default("default");
const nextToken = z.string().min(1).max(4096).optional();
const maxResults = z.number().int().min(1).max(100).default(50);

export class VolcengineTrustedAssetError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFIG_REQUIRED" | "UPSTREAM_REJECTED" | "UPSTREAM_FAILED" | "NOT_FOUND" | "PROJECT_MISMATCH" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "STALE_BINDING", message: string, public readonly status = 400) {
    super(message); this.name = "VolcengineTrustedAssetError";
  }
}

export interface VolcengineAssetGroup {
  id: string; name: string; description: string; groupType: "AIGC" | "LivenessFace"; projectName: string; createTime: string | null; updateTime: string | null;
}
export interface VolcengineTrustedAsset {
  id: string; groupId: string; name: string; assetType: "Image" | "Video" | "Audio"; status: "Active" | "Processing" | "Failed";
  projectName: string; previewUrl: string | null; createTime: string | null; updateTime: string | null; lastInferenceTime: string | null;
  moderation: { strategy: string } | null; error: { code: string; message: string } | null; assetUri: string;
}
export interface VolcengineAssetCredentials { accessKeyId: string; secretAccessKey: string }
export interface VolcengineAssetClientOptions { credentials: VolcengineAssetCredentials; fetch?: typeof fetch; now?: () => Date }

function safe(value: unknown, max = 500): string { return String(value ?? "").replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]").replace(/\b(?:AK|SK)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]").replace(/https?:\/\/[^\s<>"']+/gi, "[URL REDACTED]").slice(0, max); }
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function hmac(key: string | Buffer, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
function timestamp(now: Date): string { return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function stringField(value: unknown, max: number): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function nullableTime(value: unknown): string | null { return typeof value === "string" && value.length <= 80 ? value : null; }
function previewUrl(value: unknown): string | null {
  try { const parsed = new URL(String(value)); return ["https:", "http:"].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password ? parsed.toString() : null; }
  catch { return null; }
}
function resultOf(payload: any): any { return payload?.Result ?? payload?.result ?? {}; }

export class VolcengineTrustedAssetClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  constructor(private readonly options: VolcengineAssetClientOptions) {
    if (!options.credentials.accessKeyId.trim() || !options.credentials.secretAccessKey.trim()) throw new VolcengineTrustedAssetError("CONFIG_REQUIRED", "火山素材库只读接口需要 Access Key ID 和 Secret Access Key", 503);
    this.fetchFn = options.fetch ?? fetch; this.now = options.now ?? (() => new Date());
  }
  private redact(value: unknown, max = 500): string {
    let text = typeof value === "string" ? value : "";
    for (const secret of [this.options.credentials.accessKeyId, this.options.credentials.secretAccessKey].filter((item) => item.length >= 4)) text = text.split(secret).join("[REDACTED]");
    return safe(text, max);
  }

  async call(action: "ListAssetGroups" | "ListAssets" | "GetAsset" | "GetAssetGroup" | "CreateAssetGroup" | "CreateAsset", body: Record<string, unknown>): Promise<any> {
    const bodyText = JSON.stringify(body);
    const date = timestamp(this.now()), shortDate = date.slice(0, 8), payloadHash = sha(bodyText);
    const query = `Action=${encodeURIComponent(action)}&Version=${API_VERSION}`;
    const signedHeaders = "content-type;host;x-content-sha256;x-date";
    const canonical = ["POST", "/", query, `content-type:application/json\nhost:${HOST}\nx-content-sha256:${payloadHash}\nx-date:${date}\n`, signedHeaders, payloadHash].join("\n");
    const scope = `${shortDate}/${REGION}/${SERVICE}/request`;
    const toSign = `HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`;
    const key = hmac(hmac(hmac(hmac(this.options.credentials.secretAccessKey, shortDate), REGION), SERVICE), "request");
    const signature = createHmac("sha256", key).update(toSign).digest("hex");
    let response: Response;
    try {
      response = await this.fetchFn(`${ENDPOINT}?${query}`, { method: "POST", headers: { "Content-Type": "application/json", Host: HOST, "X-Content-Sha256": payloadHash, "X-Date": date,
        Authorization: `HMAC-SHA256 Credential=${this.options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` }, body: bodyText, signal: AbortSignal.timeout(20_000) });
    } catch { throw new VolcengineTrustedAssetError("UPSTREAM_FAILED", "火山素材库请求未获得明确结果", 502); }
    let payload: any;
    try { payload = await response.json(); } catch { throw new VolcengineTrustedAssetError("UPSTREAM_FAILED", `火山素材库返回无法解析（HTTP ${response.status}）`, 502); }
    const metadataError = payload?.ResponseMetadata?.Error ?? payload?.responseMetadata?.error ?? payload?.Error ?? payload?.error;
    if (!response.ok || metadataError) {
      const code = this.redact(metadataError?.Code ?? metadataError?.code ?? "RequestRejected", 100);
      const message = this.redact(metadataError?.Message ?? metadataError?.message ?? `HTTP ${response.status}`);
      const rejected = response.status < 500 && response.status !== 408 && (response.status >= 400 || Boolean(metadataError));
      throw new VolcengineTrustedAssetError(rejected ? "UPSTREAM_REJECTED" : "UPSTREAM_FAILED", `火山素材库请求失败：${code}${message ? `：${message}` : ""}`, rejected ? 409 : 502);
    }
    return resultOf(payload);
  }

  async listGroups(raw: unknown): Promise<{ items: VolcengineAssetGroup[]; nextToken: string | null }> {
    const input = z.object({ projectName, groupType, groupIds: z.array(remoteId).max(100).optional(), name: z.string().max(64).optional(), maxResults, nextToken, sortBy: z.enum(["CreateTime", "UpdateTime"]).default("CreateTime"), sortOrder: z.enum(["Asc", "Desc"]).default("Desc") }).strict().parse(raw);
    const result = await this.call("ListAssetGroups", { ProjectName: input.projectName, Filter: { GroupType: input.groupType, ...(input.groupIds?.length ? { GroupIds: input.groupIds } : {}), ...(input.name ? { Name: input.name } : {}) }, MaxResults: input.maxResults, ...(input.nextToken ? { NextToken: input.nextToken } : {}), SortBy: input.sortBy, SortOrder: input.sortOrder });
    const items = Array.isArray(result.Items) ? result.Items.map(groupView).filter(Boolean) as VolcengineAssetGroup[] : [];
    return { items, nextToken: typeof result.NextToken === "string" && result.NextToken ? result.NextToken : null };
  }

  async listAssets(raw: unknown): Promise<{ items: VolcengineTrustedAsset[]; nextToken: string | null }> {
    const input = z.object({ projectName, groupType, groupIds: z.array(remoteId).max(100).optional(), statuses: z.array(z.enum(["Active", "Processing", "Failed"])).max(3).optional(), name: z.string().max(64).optional(), maxResults, nextToken, sortBy: z.enum(["CreateTime", "UpdateTime", "GroupId"]).default("CreateTime"), sortOrder: z.enum(["Asc", "Desc"]).default("Desc") }).strict().parse(raw);
    const result = await this.call("ListAssets", { ProjectName: input.projectName, Filter: { GroupType: input.groupType, ...(input.groupIds?.length ? { GroupIds: input.groupIds } : {}), ...(input.statuses?.length ? { Statuses: input.statuses } : {}), ...(input.name ? { Name: input.name } : {}) }, MaxResults: input.maxResults, ...(input.nextToken ? { NextToken: input.nextToken } : {}), SortBy: input.sortBy, SortOrder: input.sortOrder });
    const items = Array.isArray(result.Items) ? result.Items.map((item: any) => assetView(item, (value) => this.redact(value))).filter(Boolean) as VolcengineTrustedAsset[] : [];
    return { items, nextToken: typeof result.NextToken === "string" && result.NextToken ? result.NextToken : null };
  }

  async getAsset(raw: unknown): Promise<VolcengineTrustedAsset> {
    const input = z.object({ id: remoteId, projectName }).strict().parse(raw);
    const item = assetView(await this.call("GetAsset", { Id: input.id, ProjectName: input.projectName }), (value) => this.redact(value));
    if (!item) throw new VolcengineTrustedAssetError("UPSTREAM_FAILED", "火山素材详情字段无效", 502); return item;
  }
  async getGroup(raw: unknown): Promise<VolcengineAssetGroup> {
    const input = z.object({ id: remoteId, projectName }).strict().parse(raw);
    const item = groupView(await this.call("GetAssetGroup", { Id: input.id, ProjectName: input.projectName }));
    if (!item) throw new VolcengineTrustedAssetError("UPSTREAM_FAILED", "火山素材组详情字段无效", 502); return item;
  }
  async createGroup(raw: unknown): Promise<{ id: string }> {
    const input = z.object({ name: z.string().trim().min(1).max(64), description: z.string().trim().max(300).optional(), groupType: z.literal("AIGC"), projectName }).strict().parse(raw);
    const result = await this.call("CreateAssetGroup", { Name: input.name, ...(input.description ? { Description: input.description } : {}), GroupType: "AIGC", ProjectName: input.projectName });
    const id = remoteId.safeParse(result?.Id);
    if (!id.success) throw new VolcengineTrustedAssetError("UPSTREAM_FAILED", "火山素材组创建结果未返回 ID", 502);
    return { id: id.data };
  }
  async createAsset(raw: unknown): Promise<{ id: string }> {
    const input = z.object({ groupId: remoteId, name: z.string().trim().min(1).max(64), assetType, projectName, url: z.string().url().max(4096) }).strict().parse(raw);
    const parsed = new URL(input.url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new VolcengineTrustedAssetError("INVALID_INPUT", "上传素材必须使用受控 HTTPS 媒体地址");
    const result = await this.call("CreateAsset", { GroupId: input.groupId, Name: input.name, AssetType: input.assetType, ProjectName: input.projectName, URL: input.url });
    const id = remoteId.safeParse(result?.Id);
    if (!id.success) throw new VolcengineTrustedAssetError("UPSTREAM_FAILED", "火山素材创建结果未返回 ID", 502);
    return { id: id.data };
  }
}

function groupView(value: any): VolcengineAssetGroup | null {
  const type = groupType.safeParse(value?.GroupType); if (!remoteId.safeParse(value?.Id).success || !type.success) return null;
  return { id: value.Id, name: stringField(value.Name, 64), description: stringField(value.Description, 300), groupType: type.data, projectName: stringField(value.ProjectName, 128) || "default", createTime: nullableTime(value.CreateTime), updateTime: nullableTime(value.UpdateTime) };
}
function assetView(value: any, sanitize: (value: unknown) => string = safe): VolcengineTrustedAsset | null {
  const type = assetType.safeParse(value?.AssetType), status = z.enum(["Active", "Processing", "Failed"]).safeParse(value?.Status);
  if (!remoteId.safeParse(value?.Id).success || !remoteId.safeParse(value?.GroupId).success || !type.success || !status.success) return null;
  const error = value.Error && (value.Error.Code || value.Error.Message) ? { code: sanitize(value.Error.Code).slice(0, 100), message: sanitize(value.Error.Message) } : null;
  return { id: value.Id, groupId: value.GroupId, name: stringField(value.Name, 64), assetType: type.data, status: status.data, projectName: stringField(value.ProjectName, 128) || "default",
    previewUrl: previewUrl(value.URL), createTime: nullableTime(value.CreateTime), updateTime: nullableTime(value.UpdateTime), lastInferenceTime: nullableTime(value.LastInferenceTime), moderation: value.Moderation ? { strategy: stringField(value.Moderation.Strategy, 100) } : null, error, assetUri: `asset://${value.Id}` };
}

export async function loadVolcengineAssetCredentials(db: Knex): Promise<VolcengineAssetCredentials> {
  const row = await db("o_vendorConfig").where({ id: "volcengineSd2" }).first("enable", "inputValues");
  if (!row || Number(row.enable) !== 1) throw new VolcengineTrustedAssetError("CONFIG_REQUIRED", "火山引擎sd2.0真人供应商未启用", 503);
  let values: any = {}; try { values = typeof row.inputValues === "string" ? JSON.parse(row.inputValues) : row.inputValues ?? {}; } catch { /* fail below */ }
  const accessKeyId = String(values.ak ?? "").trim(), secretAccessKey = String(values.sk ?? "").trim();
  if (!accessKeyId || !secretAccessKey) throw new VolcengineTrustedAssetError("CONFIG_REQUIRED", "素材库只读同步需要单独配置火山 Access Key ID 和 Secret Access Key；Ark API Key 不能替代", 503);
  return { accessKeyId, secretAccessKey };
}
export async function createConfiguredVolcengineTrustedAssetClient(db: Knex, options: Omit<VolcengineAssetClientOptions, "credentials"> = {}): Promise<VolcengineTrustedAssetClient> {
  return new VolcengineTrustedAssetClient({ ...options, credentials: await loadVolcengineAssetCredentials(db) });
}

export async function ensureVolcengineReferenceSchema(db: Knex): Promise<void> {
  await db.transaction(async (trx) => {
    if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", ["toonflow:volcengine-reference-schema"]);
    if (!(await trx.schema.hasTable(SETS))) await trx.schema.createTable(SETS, (t) => { t.bigInteger("projectId"); t.text("targetKind"); t.bigInteger("targetId"); t.bigInteger("scriptId").nullable(); t.integer("version").notNullable().defaultTo(0); t.integer("sourceVersion").notNullable(); t.text("sourceFilePath").notNullable(); t.text("sourceFileHash").notNullable(); t.text("updatedBy").notNullable(); t.bigInteger("updatedAt").notNullable(); t.primary(["projectId", "targetKind", "targetId"]); });
    else if (!(await trx.schema.hasColumn(SETS, "sourceFilePath"))) await trx.schema.alterTable(SETS, (t) => t.text("sourceFilePath").notNullable().defaultTo(""));
    if (!(await trx.schema.hasTable(ITEMS))) await trx.schema.createTable(ITEMS, (t) => { t.bigInteger("projectId"); t.text("targetKind"); t.bigInteger("targetId"); t.integer("position"); t.text("remoteProjectName").notNullable(); t.text("groupType").notNullable(); t.text("groupId").notNullable(); t.text("assetId").notNullable(); t.text("assetType").notNullable(); t.text("remoteStatus").notNullable(); t.text("remoteUpdateTime").nullable(); t.bigInteger("checkedAt").notNullable(); t.primary(["projectId", "targetKind", "targetId", "position"]); t.unique(["projectId", "targetKind", "targetId", "assetId"]); });
    if (!(await trx.schema.hasTable(RECEIPTS))) await trx.schema.createTable(RECEIPTS, (t) => { t.text("actorId"); t.bigInteger("projectId"); t.text("idempotencyKey"); t.text("requestHash"); t.text("result"); t.bigInteger("createdAt"); t.primary(["actorId", "projectId", "idempotencyKey"]); });
  });
}

export interface LocalReferenceTarget { projectId: number; scriptId?: number | null; targetKind: "asset" | "storyboard"; targetId: number }
export async function readLocalVolcengineReferenceSource(db: Knex | Knex.Transaction, target: LocalReferenceTarget): Promise<{ scriptId: number | null; version: number; filePath: string; mediaType: "image" | "video" | "audio" }> {
  if (target.targetKind === "storyboard") {
    if (!Number.isSafeInteger(target.scriptId) || Number(target.scriptId) <= 0) throw new VolcengineTrustedAssetError("INVALID_INPUT", "分镜绑定缺少剧集 ID");
    const row = await db("o_storyboard").where({ id: target.targetId, projectId: target.projectId, scriptId: target.scriptId }).first("id", "filePath");
    if (!row) throw new VolcengineTrustedAssetError("PROJECT_MISMATCH", "分镜不属于当前项目或剧集", 403);
    const state = await db("ext_entity_state").where({ entityType: "storyboard", entityId: target.targetId, projectId: target.projectId }).first("version");
    return { scriptId: Number(target.scriptId), version: Number(state?.version ?? 0), filePath: String(row.filePath ?? ""), mediaType: "image" };
  }
  const row = await db("o_assets as asset").leftJoin("o_image as image", "image.id", "asset.imageId").where({ "asset.id": target.targetId, "asset.projectId": target.projectId }).first("asset.id", "asset.type", "image.filePath", "image.type as storedFileType");
  if (!row) throw new VolcengineTrustedAssetError("PROJECT_MISMATCH", "素材不属于当前项目", 403);
  if (target.scriptId != null) {
    if (!(await db("o_script").where({ id: target.scriptId, projectId: target.projectId }).first())) throw new VolcengineTrustedAssetError("PROJECT_MISMATCH", "剧集不属于当前项目", 403);
    if (!(await db("o_scriptAssets").where({ scriptId: target.scriptId, assetId: target.targetId }).first())) throw new VolcengineTrustedAssetError("PROJECT_MISMATCH", "素材未关联到当前剧集", 403);
  }
  const state = await db("ext_creative_state").where({ entityType: "asset", entityId: target.targetId, projectId: target.projectId }).first("version");
  return { scriptId: target.scriptId == null ? null : Number(target.scriptId), version: Number(state?.version ?? 0), filePath: String(row.filePath ?? ""), mediaType: resolveVideoReferenceMediaType(row.storedFileType, row.type, row.filePath) };
}
const localSource = readLocalVolcengineReferenceSource;
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`; return JSON.stringify(value); }

export async function replaceVolcengineReferenceBindings(db: Knex, client: VolcengineTrustedAssetClient | undefined, raw: unknown, actorId: string, hashSource: (filePath: string) => Promise<string>): Promise<any> {
  await ensureVolcengineReferenceSchema(db);
  const input = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive().nullable().optional(), targetKind: z.enum(["asset", "storyboard"]), targetId: z.number().int().positive(), expectedVersion: z.number().int().nonnegative(), expectedSourceVersion: z.number().int().nonnegative(), expectedSourceFileHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), idempotencyKey: z.string().min(8).max(150).regex(/^[\w:.-]+$/), items: z.array(z.object({ remoteProjectName: projectName, groupType, groupId: remoteId, assetId: remoteId, assetType }).strict()).max(1) }).strict().parse(raw);
  if (!actorId.trim()) throw new VolcengineTrustedAssetError("INVALID_INPUT", "缺少操作者身份");
  if (new Set(input.items.map((item) => item.assetId)).size !== input.items.length) throw new VolcengineTrustedAssetError("INVALID_INPUT", "同一绑定中不能重复选择远端素材");
  const requestHash = sha(stable(input));
  const receiptKey = { actorId, projectId: input.projectId, idempotencyKey: input.idempotencyKey };
  const replay = await db(RECEIPTS).where(receiptKey).first();
  if (replay) { if (replay.requestHash !== requestHash) throw new VolcengineTrustedAssetError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同绑定", 409); return { ...JSON.parse(replay.result), reused: true }; }
  const source = await localSource(db, input);
  if (input.items.length && !source.filePath) throw new VolcengineTrustedAssetError("INVALID_INPUT", "本地目标尚无当前媒体，不能建立版本绑定");
  const sourceFileHash = source.filePath ? await hashSource(source.filePath) : "";
  if (sourceFileHash && !/^[a-f0-9]{64}$/.test(sourceFileHash)) throw new VolcengineTrustedAssetError("INVALID_INPUT", "本地来源文件哈希无效");
  const sourceHashChanged = input.expectedSourceFileHash == null ? Boolean(sourceFileHash) : sourceFileHash !== input.expectedSourceFileHash;
  if (source.version !== input.expectedSourceVersion || sourceHashChanged || (input.items.length && input.expectedSourceFileHash == null)) throw new VolcengineTrustedAssetError("VERSION_CONFLICT", "本地来源已变化，请读取当前图片后重新绑定", 409);
  const expectedRemoteType = ({ image: "Image", video: "Video", audio: "Audio" } as const)[source.mediaType];
  if (input.items.some((item) => item.assetType !== expectedRemoteType)) throw new VolcengineTrustedAssetError("INVALID_INPUT", `远端素材类型必须与本地 ${source.mediaType} 引用一致`);
  if (input.items.length && !client) throw new VolcengineTrustedAssetError("CONFIG_REQUIRED", "建立火山素材绑定需要素材库 Access Key", 503);
  const groups = new Map<string, VolcengineAssetGroup>();
  const checked: VolcengineTrustedAsset[] = [];
  for (const item of input.items) {
    const groupKey = `${item.remoteProjectName}\0${item.groupId}`;
    let group = groups.get(groupKey); if (!group) { group = await client!.getGroup({ id: item.groupId, projectName: item.remoteProjectName }); groups.set(groupKey, group); }
    const asset = await client!.getAsset({ id: item.assetId, projectName: item.remoteProjectName });
    if (group.projectName !== item.remoteProjectName || asset.projectName !== item.remoteProjectName || group.groupType !== item.groupType || asset.groupId !== item.groupId || asset.assetType !== item.assetType) throw new VolcengineTrustedAssetError("INVALID_INPUT", "远端素材与项目、素材组类型或 ID 不匹配");
    if (asset.status !== "Active") throw new VolcengineTrustedAssetError("INVALID_INPUT", `远端素材 ${item.assetId} 当前不可使用：${asset.status}`);
    checked.push(asset);
  }
  if (source.filePath && await hashSource(source.filePath) !== sourceFileHash) throw new VolcengineTrustedAssetError("VERSION_CONFLICT", "远端核验期间本地来源文件已变化，请重试", 409);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const old = await trx(RECEIPTS).where(receiptKey).first(); if (old) { if (old.requestHash !== requestHash) throw new VolcengineTrustedAssetError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同绑定", 409); return { ...JSON.parse(old.result), reused: true }; }
    const currentSource = await localSource(trx, input);
    if (currentSource.version !== source.version || currentSource.filePath !== source.filePath) throw new VolcengineTrustedAssetError("VERSION_CONFLICT", "本地来源已变化，请重新选择", 409);
    const state = await trx(SETS).where({ projectId: input.projectId, targetKind: input.targetKind, targetId: input.targetId }).forUpdate().first();
    if (Number(state?.version ?? 0) !== input.expectedVersion) throw new VolcengineTrustedAssetError("VERSION_CONFLICT", "素材库绑定已被修改，请刷新", 409);
    const now = Date.now(), version = input.expectedVersion + 1;
    await trx(SETS).insert({ projectId: input.projectId, targetKind: input.targetKind, targetId: input.targetId, scriptId: source.scriptId, version, sourceVersion: source.version, sourceFilePath: source.filePath, sourceFileHash, updatedBy: actorId, updatedAt: now }).onConflict(["projectId", "targetKind", "targetId"]).merge();
    await trx(ITEMS).where({ projectId: input.projectId, targetKind: input.targetKind, targetId: input.targetId }).delete();
    if (checked.length) await trx(ITEMS).insert(checked.map((asset, position) => ({ projectId: input.projectId, targetKind: input.targetKind, targetId: input.targetId, position, remoteProjectName: asset.projectName, groupType: input.items[position].groupType, groupId: asset.groupId, assetId: asset.id, assetType: asset.assetType, remoteStatus: asset.status, remoteUpdateTime: asset.updateTime, checkedAt: now })));
    const result = await readVolcengineReferenceBindings(trx, input); await trx(RECEIPTS).insert({ ...receiptKey, requestHash, result: JSON.stringify(result), createdAt: now }); return { ...result, reused: false };
  });
}

export async function readVolcengineReferenceBindings(db: Knex | Knex.Transaction, target: LocalReferenceTarget, hashSource?: (filePath: string) => Promise<string>): Promise<any> {
  const source = await localSource(db, target);
  const hashRequired = Boolean(source.filePath && hashSource);
  const currentSourceFileHash = source.filePath && hashSource ? await hashSource(source.filePath).catch(() => null) : null;
  if (!(await db.schema.hasTable(SETS))) return { ...target, version: 0, sourceVersion: source.version, sourceFileHash: null, currentSourceVersion: source.version, currentSourceFileHash, currentMediaType: source.mediaType, sourceCurrent: true, items: [] };
  const state = await db(SETS).where({ projectId: target.projectId, targetKind: target.targetKind, targetId: target.targetId }).first();
  if (!state) return { ...target, version: 0, sourceVersion: source.version, sourceFileHash: null, currentSourceVersion: source.version, currentSourceFileHash, currentMediaType: source.mediaType, sourceCurrent: true, items: [] };
  const items = await db(ITEMS).where({ projectId: target.projectId, targetKind: target.targetKind, targetId: target.targetId }).orderBy("position");
  return { ...target, scriptId: target.scriptId == null ? null : Number(target.scriptId), version: Number(state.version), sourceVersion: Number(state.sourceVersion), sourceFileHash: state.sourceFileHash, currentSourceVersion: source.version, currentSourceFileHash, currentMediaType: source.mediaType, sourceCurrent: source.version === Number(state.sourceVersion) && source.filePath === state.sourceFilePath && (!hashRequired || currentSourceFileHash === state.sourceFileHash), items: items.map((row) => ({ position: Number(row.position), remoteProjectName: row.remoteProjectName, groupType: row.groupType, groupId: row.groupId, assetId: row.assetId, assetType: row.assetType, remoteStatus: row.remoteStatus, remoteUpdateTime: row.remoteUpdateTime, checkedAt: Number(row.checkedAt), assetUri: `asset://${row.assetId}` })) };
}

export async function readBoundVolcengineReferences(db: Knex | Knex.Transaction, target: LocalReferenceTarget): Promise<{ bindingVersion: number; sourceVersion: number; sourceFileHash: string | null; sourceCurrent: boolean; bindingState: "unbound" | "active" | "stale" | "remote_inactive"; references: Array<{ type: "image" | "video" | "audio"; url: string; assetId: string; groupId: string; groupType: "AIGC" | "LivenessFace"; remoteStatus: string }> }> {
  const view = await readVolcengineReferenceBindings(db, target);
  const references = view.sourceCurrent ? view.items.filter((item: any) => item.remoteStatus === "Active").map((item: any) => ({ type: ({ Image: "image", Video: "video", Audio: "audio" } as const)[item.assetType as "Image" | "Video" | "Audio"], url: item.assetUri, assetId: item.assetId, groupId: item.groupId, groupType: item.groupType, remoteStatus: item.remoteStatus })) : [];
  const bindingState = !view.items.length ? "unbound" : !view.sourceCurrent ? "stale" : references.length ? "active" : "remote_inactive";
  return { bindingVersion: view.version, sourceVersion: view.sourceVersion, sourceFileHash: view.sourceFileHash, sourceCurrent: view.sourceCurrent, bindingState, references };
}

export interface VolcengineBindingSnapshot {
  inputIndex: number; id: number; sources: "assets" | "storyboard"; bindingVersion: number; assetId: string; assetType: "Image" | "Video" | "Audio";
  groupId: string; groupType: "AIGC" | "LivenessFace"; remoteProjectName: string; remoteStatus: string; sourceVersion: number; sourceFileHash: string; sourceCurrent: boolean;
}
/** Local-only immutable metadata for prompt/job hashes. This function never calls Volcengine. */
export async function readVolcengineBindingSnapshots(db: Knex | Knex.Transaction, input: { projectId: number; scriptId: number; refs: Array<{ id: number; sources: "assets" | "storyboard"; fileType?: "image" | "video" | "audio" }> }, hashSource?: (filePath: string) => Promise<string>): Promise<VolcengineBindingSnapshot[]> {
  const snapshots: VolcengineBindingSnapshot[] = [];
  if (!(await db.schema.hasTable(SETS))) return snapshots;
  for (let inputIndex = 0; inputIndex < input.refs.length; inputIndex += 1) {
    const ref = input.refs[inputIndex];
    const targetKind = ref.sources === "assets" ? "asset" : "storyboard";
    if (!(await db(SETS).where({ projectId: input.projectId, targetKind, targetId: ref.id }).first("version"))) continue;
    const view = await readVolcengineReferenceBindings(db, { projectId: input.projectId, scriptId: input.scriptId, targetKind, targetId: ref.id }, hashSource);
    const item = view.items[0];
    if (!item || typeof view.sourceFileHash !== "string") continue;
    snapshots.push({ inputIndex, id: ref.id, sources: ref.sources, bindingVersion: Number(view.version), assetId: item.assetId, assetType: item.assetType, groupId: item.groupId, groupType: item.groupType,
      remoteProjectName: item.remoteProjectName, remoteStatus: item.remoteStatus, sourceVersion: Number(view.sourceVersion), sourceFileHash: view.sourceFileHash, sourceCurrent: Boolean(view.sourceCurrent) });
  }
  return snapshots;
}

/** Revalidate one frozen binding outside a DB transaction immediately before provider submission. */
export async function resolveCurrentVolcengineReference(db: Knex, client: VolcengineTrustedAssetClient, target: LocalReferenceTarget, expected: VolcengineBindingSnapshot | undefined, hashSource: (filePath: string) => Promise<string>): Promise<{ type: "image" | "video" | "audio"; url: string; snapshot: VolcengineBindingSnapshot } | undefined> {
  const current = await readVolcengineBindingSnapshots(db, { projectId: target.projectId, scriptId: Number(target.scriptId), refs: [{ id: target.targetId, sources: target.targetKind === "asset" ? "assets" : "storyboard" }] }, hashSource);
  if (!current.length) {
    if (expected) throw new VolcengineTrustedAssetError("STALE_BINDING", "火山素材绑定已取消，禁止提交旧引用", 409);
    return undefined;
  }
  const snapshot = current[0];
  if (!snapshot.sourceCurrent || (expected && stable(snapshot) !== stable({ ...expected, inputIndex: snapshot.inputIndex }))) throw new VolcengineTrustedAssetError("STALE_BINDING", "火山素材绑定或本地来源已变化，禁止提交旧引用", 409);
  const [asset, group] = await Promise.all([client.getAsset({ id: snapshot.assetId, projectName: snapshot.remoteProjectName }), client.getGroup({ id: snapshot.groupId, projectName: snapshot.remoteProjectName })]);
  if (asset.status !== "Active" || asset.groupId !== snapshot.groupId || asset.assetType !== snapshot.assetType || group.groupType !== snapshot.groupType) throw new VolcengineTrustedAssetError("STALE_BINDING", "火山素材当前未激活或授权素材组已变化", 409);
  const type = ({ Image: "image", Video: "video", Audio: "audio" } as const)[snapshot.assetType];
  return { type, url: asset.assetUri, snapshot };
}

export async function syncVolcengineReferenceBindings(db: Knex, client: VolcengineTrustedAssetClient, target: LocalReferenceTarget, hashSource?: (filePath: string) => Promise<string>): Promise<any> {
  const current = await readVolcengineReferenceBindings(db, target), updates = [] as Array<{ item: any; asset: VolcengineTrustedAsset }>;
  for (const item of current.items) updates.push({ item, asset: await client.getAsset({ id: item.assetId, projectName: item.remoteProjectName }) });
  if (updates.length) await db.transaction(async (trx) => { await lockProjectTransaction(trx, target.projectId); for (const { item, asset } of updates) await trx(ITEMS).where({ projectId: target.projectId, targetKind: target.targetKind, targetId: target.targetId, assetId: asset.id }).update({ remoteStatus: asset.groupId === item.groupId && asset.assetType === item.assetType ? asset.status : "Failed", remoteUpdateTime: asset.updateTime, checkedAt: Date.now() }); });
  return readVolcengineReferenceBindings(db, target, hashSource);
}
