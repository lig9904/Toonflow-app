/**
 * AI 开放平台（KZ）视频兼容接口供应商。
 *
 * The platform supplies a BASE_URL through its management console. It is
 * intentionally left blank here: the Apifox documentation host is not an
 * API host and must never be used as a default.
 *
 * Reference media is accepted only as a public HTTPS/HTTP URL or an
 * asset://<id> reference. The server-side video reference bridge converts
 * verified local project media into that URL form; direct local base64 input
 * is rejected because the platform docs do not define a binary upload API.
 */

type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "startFrameOptional"
  | "endFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];
type MediaType = "image" | "video" | "audio";
type Reference = {
  type: MediaType;
  sourceType?: "base64" | "url" | "asset";
  base64?: string;
  url?: string;
  assetId?: string;
};

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  audio: "optional";
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
  referenceRatio?: "adaptive";
}
interface Vendor {
  id: string;
  version: string;
  name: string;
  author: string;
  description: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  referenceTransport?: "base64" | "url";
  models: VideoModel[];
}
interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: string;
  prompt: string;
  referenceList?: Reference[];
  audio?: boolean;
  mode: VideoMode[] | VideoMode;
  /** Supported by the Seedance 2.5 omni reference task type. */
  omniReferenceTaskType?: "auto" | "reference" | "edit" | "extend";
  /** Alias accepted for callers that use a shorter application-level name. */
  taskType?: "auto" | "reference" | "edit" | "extend";
}
interface VideoSubmitResult { taskId: string; }
interface VideoQueryResult { status: "pending" | "succeeded" | "failed"; outputUrl?: string; error?: string; }

declare const fetch: typeof globalThis.fetch;
declare const pollTask: (fn: () => Promise<{ completed: boolean; data?: string; error?: string }>, interval?: number, timeout?: number) => Promise<{ completed: boolean; data?: string; error?: string }>;
declare const logger: (message: string) => void;
declare const AbortController: any;
declare const setTimeout: (handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => any;
declare const clearTimeout: (id: any) => void;
declare const exports: any;

const persistentVideoTaskVersion = 1;
const VIDEO_PATH = "/ai-open-platform-api/api/v3/contents/generations/tasks";
const ASSET_PATH = "/ai-open-platform-api/api/support/v1/asset";
const ASSET_VERSION = "2024-01-01";
const MODEL_LIMITS: Record<string, { maxDuration: number; resolutions: string[]; image: number; video: number; audio: number; seedance25: boolean }> = {
  "doubao-seedance-2-0-260128": { maxDuration: 15, resolutions: ["480p", "720p", "1080p", "4k"], image: 9, video: 3, audio: 3, seedance25: false },
  "doubao-seedance-2-0-fast-260128": { maxDuration: 15, resolutions: ["480p", "720p", "1080p"], image: 9, video: 3, audio: 3, seedance25: false },
  "doubao-seedance-2-0-mini-260615": { maxDuration: 15, resolutions: ["480p", "720p", "1080p"], image: 9, video: 3, audio: 3, seedance25: false },
  "doubao-seedance-2-5-260628": { maxDuration: 30, resolutions: ["480p", "720p", "1080p"], image: 30, video: 10, audio: 10, seedance25: true },
};
const RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"];
const IMAGE_ROLES = new Set(["first_frame", "last_frame", "reference_image"]);

const vendor: Vendor = {
  id: "kzOpenApi",
  version: "1.0",
  name: "筷子科技·丽帧",
  author: "Toonflow",
  description: "AI 开放平台 Seedance 2.0/2.5 视频兼容接口。仅包含文生视频与参考素材视频；未声明图片、文本或 TTS 能力。",
  inputs: [
    { key: "apiKey", label: "平台ApiKey", type: "password", required: true, placeholder: "AI 开放平台 ApiKey" },
    { key: "baseUrl", label: "平台BASE_URL", type: "url", required: true, placeholder: "由 AI 开放平台后台提供的 HTTPS 地址" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://aiopenapi.kuaizi.cn" },
  referenceTransport: "url",
  models: [
    model("Seedance 2.0 Pro", "doubao-seedance-2-0-260128"),
    model("Seedance 2.0 Fast", "doubao-seedance-2-0-fast-260128"),
    model("Seedance 2.0 Mini", "doubao-seedance-2-0-mini-260615"),
    model("Seedance 2.5", "doubao-seedance-2-5-260628"),
  ],
};

function model(name: string, modelName: string): VideoModel {
  const limits = MODEL_LIMITS[modelName];
  return {
    name,
    modelName,
    type: "video",
    mode: ["text", "singleImage", "startFrameOptional", "startEndRequired", "endFrameOptional", [
      `imageReference:${limits.image}`,
      `videoReference:${limits.video}`,
      `audioReference:${limits.audio}`,
    ]],
    audio: "optional",
    ...(limits.seedance25 ? { referenceRatio: "adaptive" as const } : {}),
    durationResolutionMap: [{ duration: Array.from({ length: limits.maxDuration - 3 }, (_v, i) => i + 4), resolution: limits.resolutions }],
  };
}

function configuredApiKey(): string {
  const value = String(vendor.inputValues.apiKey || "").trim().replace(/^Bearer\s+/i, "").trim();
  if (!value) throw new Error("缺少 AI 开放平台 ApiKey");
  return value;
}

function configuredOrigin(): string {
  let parsed: URL;
  try { parsed = new URL(String(vendor.inputValues.baseUrl || "").trim()); } catch { throw new Error("AI 开放平台 BASE_URL 必须是后台提供的合法 HTTPS 地址"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("AI 开放平台 BASE_URL 只允许不含凭据、路径、查询和片段的 HTTPS origin");
  }
  return parsed.origin;
}

function safeError(error: unknown): string {
  let text = String(error instanceof Error ? error.message : error);
  const key = String(vendor.inputValues.apiKey || "").trim().replace(/^Bearer\s+/i, "").trim();
  if (key) text = text.split(key).join("[redacted]");
  return text
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/ApiKey\s*:\s*[^\s]+/gi, "ApiKey: [redacted]")
    .replace(/https?:\/\/[^\s"']+/gi, "[url]")
    .slice(0, 500);
}

function taskIdentifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("AI 开放平台任务 ID 无效");
  return value.trim();
}

function mediaReference(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}缺少素材引用`);
  const reference = value.trim();
  if (reference.startsWith("asset://")) {
    if (!/^asset:\/\/[1-9]\d*$/.test(reference)) throw new Error(`${label} asset:// ID 无效`);
    return reference;
  }
  let parsed: URL;
  try { parsed = new URL(reference); } catch { throw new Error(`${label}必须是公网 URL 或 asset://ID`); }
  if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error(`${label}必须是公网 URL 或 asset://ID`);
  return reference;
}

function outputVideoUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("视频结果必须是公网 HTTP(S) URL");
  const result = value.trim();
  let parsed: URL;
  try { parsed = new URL(result); } catch { throw new Error("视频结果必须是公网 HTTP(S) URL"); }
  if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error("视频结果必须是公网 HTTP(S) URL");
  return result;
}

function referenceValue(reference: Reference, index: number): string {
  const source = reference.url || reference.base64 || (reference.assetId ? `asset://${reference.assetId}` : "");
  if (typeof source !== "string" || !source.trim()) throw new Error(`参考素材${index + 1}缺少 URL 或 asset://ID`);
  if (/^data:/i.test(source)) throw new Error("AI 开放平台未在已审文档中提供 data URI/二进制上传接口；本地 base64 参考素材需要先通过受控公网 URL 或平台 asset://ID 桥接");
  return mediaReference(source, `参考素材${index + 1}`);
}

function flattenMode(mode: VideoConfig["mode"]): string[] {
  const values: any[] = Array.isArray(mode) ? mode : [mode];
  return values.flatMap((value) => Array.isArray(value) ? value : [value]).filter((value): value is string => typeof value === "string");
}

function modelLimits(modelName: string): typeof MODEL_LIMITS[string] {
  const limits = MODEL_LIMITS[modelName];
  if (!limits) throw new Error(`未适配的 AI 开放平台视频模型: ${modelName}`);
  return limits;
}

function contentFor(config: VideoConfig, limits: typeof MODEL_LIMITS[string]): { content: any[]; hasFirstOrLast: boolean; counts: Record<MediaType, number> } {
  const refs = config.referenceList || [];
  if (!Array.isArray(refs)) throw new Error("参考素材必须是数组");
  const modeItems = flattenMode(config.mode);
  const hasStructuredReferenceMode = modeItems.some((item) => /^(image|video|audio)Reference:\d+$/.test(item));
  const text = typeof config.prompt === "string" ? config.prompt.trim() : "";
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  const counts: Record<MediaType, number> = { image: 0, video: 0, audio: 0 };
  let hasFirstOrLast = false;

  if (config.mode === "text") {
    if (refs.length) throw new Error("文生视频模式不接受参考素材");
  } else if (config.mode === "singleImage" || config.mode === "startFrameOptional" || config.mode === "startEndRequired" || config.mode === "endFrameOptional") {
    const images = refs.filter((ref) => ref?.type === "image");
    if (images.length !== refs.length) throw new Error("首帧/尾帧模式只能使用图片参考");
    if (config.mode === "singleImage" && images.length !== 1) throw new Error("单图模式需要恰好一张图片");
    if (config.mode === "startEndRequired" && images.length !== 2) throw new Error("首尾帧模式需要恰好两张图片");
    if (config.mode === "startFrameOptional" && images.length > 2) throw new Error("首帧模式最多两张图片");
    if (config.mode === "endFrameOptional" && images.length > 2) throw new Error("首尾帧模式最多两张图片");
    if (images.length === 0) throw new Error("图生视频模式至少需要一张图片");
    images.forEach((ref, index) => {
      const url = referenceValue(ref, index);
      const role = index === 0 ? "first_frame" : "last_frame";
      content.push({ type: "image_url", role, image_url: { url } });
      counts.image += 1;
      hasFirstOrLast = true;
    });
  } else if (hasStructuredReferenceMode) {
    const declared: Record<MediaType, number> = { image: 0, video: 0, audio: 0 };
    for (const item of modeItems) {
      const match = item.match(/^(image|video|audio)Reference:(\d+)$/);
      if (!match) continue;
      const type = match[1] as MediaType;
      const max = Number(match[2]);
      if (declared[type]) throw new Error("多参考模式重复声明素材类型");
      if (max > limits[type]) throw new Error("多参考模式数量配置超过平台上限");
      declared[type] = max;
    }
    for (const ref of refs) {
      if (!ref || !["image", "video", "audio"].includes(ref.type)) throw new Error("参考素材类型不合法");
      counts[ref.type] += 1;
      if (counts[ref.type] > limits[ref.type] || counts[ref.type] > declared[ref.type]) throw new Error("参考素材数量超过模型或所选模式上限");
      const url = referenceValue(ref, counts[ref.type] - 1);
      const type = ref.type;
      content.push({ type: `${type}_url`, role: `reference_${type}`, [`${type}_url`]: { url } });
    }
    if (!refs.length) throw new Error("多模态参考模式至少需要一个参考素材");
  } else if (refs.length) {
    throw new Error("视频模式与参考素材不匹配");
  }
  if (!content.some((item) => item.type === "text" || item.type === "image_url" || item.type === "video_url")) throw new Error("content 至少需要 text、image_url 或 video_url");
  return { content, hasFirstOrLast, counts };
}

function validateConfig(config: VideoConfig, modelName: string): { content: any[]; limits: typeof MODEL_LIMITS[string]; hasFirstOrLast: boolean; ratio: string } {
  const limits = modelLimits(modelName);
  if (!Number.isInteger(config.duration) || (config.duration !== -1 && (config.duration < 4 || config.duration > limits.maxDuration))) throw new Error(`该模型时长仅支持 4~${limits.maxDuration} 秒整数或 -1`);
  if (!limits.resolutions.includes(config.resolution)) throw new Error(`该模型不支持 ${config.resolution}，可选分辨率：${limits.resolutions.join("、")}`);
  if (typeof config.aspectRatio !== "string" || !RATIOS.includes(config.aspectRatio)) throw new Error("不支持的视频画面比例");
  const taskType = config.omniReferenceTaskType || config.taskType || (config as any).omni_reference_task_type || "auto";
  if (!["auto", "reference", "edit", "extend"].includes(taskType)) throw new Error("omni_reference_task_type 仅支持 auto/reference/edit/extend");
  if (taskType !== "auto" && !limits.seedance25) throw new Error("omni_reference_task_type 仅适用于 Seedance 2.5");
  const built = contentFor(config, limits);
  let ratio = config.aspectRatio;
  // The application workbench stores a project-wide ratio. For 2.5 frame,
  // edit, and extend tasks the platform follows the input media instead;
  // map that fixed UI value to the documented adaptive request value.
  if (limits.seedance25 && (built.hasFirstOrLast || taskType === "edit" || taskType === "extend")) ratio = "adaptive";
  if (taskType === "edit") {
    if (!built.content.some((item) => item.type === "video_url" && item.role === "reference_video")) throw new Error("视频编辑任务至少需要一个 reference_video");
    if (config.duration !== -1) throw new Error("Seedance 2.5 视频编辑任务 duration 必须为 -1");
  }
  if (taskType === "extend") {
    if (!built.content.some((item) => item.type === "video_url" && item.role === "reference_video")) throw new Error("视频延长任务至少需要一个 reference_video");
    // The effective ratio is mapped above from the project-wide UI ratio.
  }
  if (!limits.seedance25 && built.counts.audio > 0 && built.counts.image === 0 && built.counts.video === 0) throw new Error("Seedance 2.0 音频参考必须同时提供图片或视频");
  return { content: built.content, limits, hasFirstOrLast: built.hasFirstOrLast, ratio };
}

function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error("AI 开放平台请求超过 55 秒截止时间");
  return Math.min(55_000, value);
}

async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: any;
  const timedOut = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("AI 开放平台请求超时")); }, Math.max(1, timeoutMs)); });
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timedOut]); }
  finally { clearTimeout(timer); }
}

async function requestJson(url: string, init: RequestInit, timeoutMs = 55_000): Promise<any> {
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await bounded(async (signal) => {
      const result = await fetch(url, { ...init, signal, redirect: "error" });
      return { response: result, text: await result.text() };
    }, timeoutMs));
  } catch (error) {
    throw new Error(`AI 开放平台请求失败: ${safeError(error)}`);
  }
  let data: any;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`AI 开放平台返回了无效 JSON（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(`AI 开放平台 HTTP ${response.status}: ${safeError(data?.message || data?.ResponseMetadata?.Error?.Message || text || "请求失败")}`);
  return data;
}

function videoHeaders(): Record<string, string> { return { Authorization: `Bearer ${configuredApiKey()}`, "Content-Type": "application/json" }; }

const submitVideoTask = async (config: VideoConfig, model: VideoModel): Promise<VideoSubmitResult> => {
  const validated = validateConfig(config, model.modelName);
  const body: any = {
    model: model.modelName,
    content: validated.content,
    resolution: config.resolution,
    ratio: validated.ratio,
    duration: config.duration,
    generate_audio: config.audio !== false,
    watermark: false,
  };
  const taskType = config.omniReferenceTaskType || config.taskType || (config as any).omni_reference_task_type;
  if (taskType) body.omni_reference_task_type = taskType;
  const response = await requestJson(`${configuredOrigin()}${VIDEO_PATH}`, { method: "POST", headers: videoHeaders(), body: JSON.stringify(body) }, remaining(Date.now() + 55_000));
  if (response?.error) throw new Error(`AI 开放平台视频创建失败: ${safeError(response.error.message || response.error.code || response.error)}`);
  if (response?.code && !response?.id) throw new Error(`AI 开放平台视频创建失败: ${safeError(response.message || response.code)}`);
  const taskId = taskIdentifier(response?.id);
  logger(`[AI开放平台视频] 任务已创建: ${taskId}`);
  return { taskId };
};

const queryVideoTask = async (input: string | { taskId: string }): Promise<VideoQueryResult> => {
  const taskId = taskIdentifier(typeof input === "string" ? input : input?.taskId);
  const task = await requestJson(`${configuredOrigin()}${VIDEO_PATH}/${encodeURIComponent(taskId)}`, { method: "GET", headers: { Authorization: `Bearer ${configuredApiKey()}` } }, 15_000);
  switch (task?.status) {
    case "queued":
    case "running": return { status: "pending" };
    case "succeeded": {
      const url = task.content?.kz_video_url || task.content?.video_url;
      if (!url) throw new Error("视频任务成功但未返回有效视频 URL");
      return { status: "succeeded", outputUrl: outputVideoUrl(url) };
    }
    case "failed": return { status: "failed", error: safeError(task.error?.message || task.error?.code || "视频生成失败") };
    case "expired": return { status: "failed", error: "视频生成任务已过期" };
    case "cancelled": return { status: "failed", error: "视频生成任务已取消" };
    default: throw new Error(`视频任务返回了未知状态: ${String(task?.status || "<empty>")}`);
  }
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  const submitted = await submitVideoTask(config, model);
  const result = await pollTask(async () => {
    const queried = await queryVideoTask(submitted.taskId);
    if (queried.status === "pending") return { completed: false };
    if (queried.status === "succeeded") return { completed: true, data: queried.outputUrl };
    return { completed: true, error: queried.error || "视频生成失败" };
  }, 5_000, 30 * 60_000);
  if (result.error || !result.data) throw new Error(result.error || "视频任务成功但未返回 URL");
  return result.data;
};

type AssetAction = "CreateAssetGroup" | "ListAssetGroups" | "GetAssetGroup" | "UpdateAssetGroup" | "DeleteAssetGroup" | "CreateAsset" | "ListAssets" | "GetAsset" | "UpdateAsset" | "DeleteAsset";
async function assetRequest(action: AssetAction, body: Record<string, unknown>): Promise<any> {
  const url = new URL(`${configuredOrigin()}${ASSET_PATH}`);
  url.searchParams.set("Action", action);
  url.searchParams.set("Version", ASSET_VERSION);
  const data = await requestJson(url.toString(), { method: "POST", headers: { ApiKey: configuredApiKey(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const error = data?.ResponseMetadata?.Error;
  if (error) throw new Error(`AI 开放平台素材 ${action} 失败: ${safeError(error.Message || error.Code || "请求失败")}`);
  if (data?.Result === undefined) throw new Error(`AI 开放平台素材 ${action} 返回缺少 Result`);
  return data.Result;
}

function assetId(value: unknown, label = "素材 ID"): string {
  if ((typeof value !== "string" && typeof value !== "number") || (typeof value === "number" && !Number.isSafeInteger(value))) throw new Error(`${label}无效`);
  const id = String(value);
  if (!/^[1-9]\d*$/.test(id)) throw new Error(`${label}必须是十进制字符串`);
  return id;
}
function assetUrl(value: unknown): string {
  if (typeof value !== "string" || /^data:/i.test(value)) throw new Error("素材 URL 必须是公网 URL；文档未承诺 data URI/二进制上传");
  return mediaReference(value, "素材 URL");
}
const createAssetGroup = (input: { Name: string; Description?: string; GroupType?: string }) => assetRequest("CreateAssetGroup", { ...input, GroupType: input.GroupType || "AIGC" });
const listAssetGroups = (input: Record<string, unknown> = {}) => assetRequest("ListAssetGroups", input);
const getAssetGroup = (id: string | number) => assetRequest("GetAssetGroup", { Id: assetId(id, "素材组 ID") });
const updateAssetGroup = (input: { Id: string | number; Name?: string; Description?: string }) => assetRequest("UpdateAssetGroup", { ...input, Id: assetId(input.Id, "素材组 ID") });
const deleteAssetGroup = (id: string | number) => assetRequest("DeleteAssetGroup", { Id: assetId(id, "素材组 ID") });
const createAsset = (input: { GroupId: string | number; URL: string; AssetType: "Image" | "Video" | "Audio"; Name?: string }) => assetRequest("CreateAsset", { ...input, GroupId: assetId(input.GroupId, "素材组 ID"), URL: assetUrl(input.URL) });
const listAssets = (input: Record<string, unknown> = {}) => assetRequest("ListAssets", input);
const getAsset = (id: string | number) => assetRequest("GetAsset", { Id: assetId(id) });
const updateAsset = (input: { Id: string | number; Name: string }) => assetRequest("UpdateAsset", { ...input, Id: assetId(input.Id) });
const deleteAsset = (id: string | number) => assetRequest("DeleteAsset", { Id: assetId(id) });

exports.vendor = vendor;
exports.videoRequest = videoRequest;
exports.submitVideoTask = submitVideoTask;
exports.queryVideoTask = queryVideoTask;
exports.persistentVideoTaskVersion = persistentVideoTaskVersion;
exports.createAssetGroup = createAssetGroup;
exports.listAssetGroups = listAssetGroups;
exports.getAssetGroup = getAssetGroup;
exports.updateAssetGroup = updateAssetGroup;
exports.deleteAssetGroup = deleteAssetGroup;
exports.createAsset = createAsset;
exports.listAssets = listAssets;
exports.getAsset = getAsset;
exports.updateAsset = updateAsset;
exports.deleteAsset = deleteAsset;

export {};
