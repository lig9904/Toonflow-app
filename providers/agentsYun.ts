/**
 * Agent云图像/Seedance provider.
 *
 * The API host is the verified Agent云 relay origin. This adapter contains
 * no credentials and never retries a paid create request after ambiguity.
 */
type VideoMode = "singleImage" | "startEndRequired" | "endFrameOptional" | "text" | (`imageReference:${number}` | `videoReference:${number}` | `audioReference:${number}`)[];
type MediaType = "image" | "video" | "audio";
type Reference = { type: MediaType; sourceType?: "base64" | "url"; base64?: string; url?: string };
interface ImageModel { name: string; modelName: string; type: "image"; mode: ("text" | "singleImage" | "multiReference")[]; resolutions: string[]; }
interface VideoModel { name: string; modelName: string; type: "video"; mode: VideoMode[]; audio: "optional"; durationResolutionMap: { duration: number[]; resolution: string[] }[]; referenceTransport?: "url"; referenceRatio?: "adaptive"; }
interface Vendor { id: string; version: string; name: string; author: string; description: string; inputs: { key: string; label: string; type: "password" | "url"; required: boolean; placeholder?: string }[]; inputValues: Record<string, string>; models: (ImageModel | VideoModel)[]; }
interface ImageReference { type: "image"; sourceType?: "base64" | "url"; base64?: string; url?: string; }
interface ImageConfig { prompt: string; referenceList?: ImageReference[]; size: string; aspectRatio: string; responseFormat?: "url" | "b64_json"; seed?: number; outputFormat?: "png" | "jpeg"; }
interface VideoConfig { duration: number; resolution: string; aspectRatio: string; prompt: string; referenceList?: Reference[]; audio?: boolean; mode: VideoMode[] | VideoMode; }
interface ImageSyncResult { outputUrl?: string; outputBase64?: string; mimeType?: "image/png" | "image/jpeg"; }
interface VideoSubmitResult { taskId: string; }
interface VideoQueryResult { status: "pending" | "succeeded" | "failed"; outputUrl?: string; error?: string; }

declare const fetch: typeof globalThis.fetch;
declare const Buffer: any;
declare const AbortController: any;
declare const setTimeout: (handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => any;
declare const clearTimeout: (id: any) => void;
declare const pollTask: (fn: () => Promise<{ completed: boolean; data?: string; error?: string }>, interval?: number, timeout?: number) => Promise<{ completed: boolean; data?: string; error?: string }>;
declare const logger: (message: string) => void;
declare const exports: any;

const persistentVideoTaskVersion = 1;
const synchronousImageRequestVersion = 1;
const IMAGE_PATH = "/relay/v1/image/stellar/generations";
const VIDEO_PATH = "/relay/v1/video/seedance2";
const models: Record<string, { kind: "image" | "video"; resolutions: string[]; maxDuration?: number; image?: number; video?: number; audio?: number; seedance25?: boolean }> = {
  "Seedream-4.5": { kind: "image", resolutions: ["2K", "4K"] },
  "Doubao-Seedream-4.5": { kind: "image", resolutions: ["2K", "4K"] },
  "Doubao-Seedream-5.0-Lite": { kind: "image", resolutions: ["2K", "3K", "4K"] },
  "Doubao-Seedance-2.0": { kind: "video", resolutions: ["480p", "720p", "1080p", "4k"], maxDuration: 15, image: 9, video: 3, audio: 3 },
  "Doubao-Seedance-2.0-mini": { kind: "video", resolutions: ["480p", "720p"], maxDuration: 15, image: 9, video: 3, audio: 3 },
  "Doubao-Seedance-2.0-fast": { kind: "video", resolutions: ["480p", "720p"], maxDuration: 15, image: 9, video: 3, audio: 3 },
  "Doubao-Seedance-2.5": { kind: "video", resolutions: ["480p", "720p", "1080p"], maxDuration: 30, image: 30, video: 10, audio: 10, seedance25: true },
};
const ratios = new Set(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]);

const vendor: Vendor = {
  id: "agentsYun",
  version: "1.0",
  name: "Agent云",
  author: "Toonflow",
  description: "Agent云图像与 Seedance 视频接口。仅声明文档确认的 3 个图像模型和 4 个 Seedance 视频模型。",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true, placeholder: "Agent云 API Key" },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "由 Agent云 管理后台提供的 HTTPS 地址" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://api.agentsyun.com/relay/v1" },
  models: [
    { name: "Seedream 4.5", modelName: "Seedream-4.5", type: "image", mode: ["text", "singleImage", "multiReference"], resolutions: ["2K", "4K"] },
    { name: "Doubao Seedream 4.5", modelName: "Doubao-Seedream-4.5", type: "image", mode: ["text", "singleImage", "multiReference"], resolutions: ["2K", "4K"] },
    { name: "Doubao Seedream 5.0 Lite", modelName: "Doubao-Seedream-5.0-Lite", type: "image", mode: ["text", "singleImage", "multiReference"], resolutions: ["2K", "3K", "4K"] },
    videoModel("Doubao Seedance 2.0", "Doubao-Seedance-2.0"),
    videoModel("Doubao Seedance 2.0 Mini", "Doubao-Seedance-2.0-mini"),
    videoModel("Doubao Seedance 2.0 Fast", "Doubao-Seedance-2.0-fast"),
    videoModel("Doubao Seedance 2.5", "Doubao-Seedance-2.5"),
  ],
};

function videoModel(name: string, modelName: string): VideoModel {
  const spec = models[modelName];
  const mode: VideoMode[] = spec.seedance25
    ? ["text", "singleImage", "startEndRequired", "endFrameOptional", [`imageReference:${spec.image!}`, `videoReference:${spec.video!}`, `audioReference:${spec.audio!}`]]
    : ["text", "singleImage", [`imageReference:${spec.image!}`, `videoReference:${spec.video!}`, `audioReference:${spec.audio!}`]];
  return { name, modelName, type: "video", mode, audio: "optional", durationResolutionMap: [{ duration: Array.from({ length: spec.maxDuration! - 3 }, (_v, i) => i + 4), resolution: spec.resolutions }], referenceTransport: "url", ...(spec.seedance25 ? { referenceRatio: "adaptive" } : {}) };
}

function origin(): string {
  let parsed: URL;
  try { parsed = new URL(String(vendor.inputValues.baseUrl || "").trim()); } catch { throw new Error("Agent云 请求地址必须由管理后台提供，且为合法 HTTPS origin"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !["/", "/relay/v1", "/relay/v1/"].includes(parsed.pathname) || parsed.search || parsed.hash) throw new Error("Agent云 请求地址只允许无凭据、查询和片段的 HTTPS origin 或 /relay/v1");
  return parsed.origin;
}
function key(): string {
  const value = String(vendor.inputValues.apiKey || "").trim().replace(/^Bearer\s+/i, "").trim();
  if (!value) throw new Error("缺少 Agent云 API Key");
  return value;
}
function safeError(error: unknown): string {
  let text = String(error instanceof Error ? error.message : error);
  const secret = String(vendor.inputValues.apiKey || "").trim().replace(/^Bearer\s+/i, "").trim();
  if (secret) text = text.split(secret).join("[redacted]");
  return text.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").replace(/https?:\/\/[^\s"']+/gi, "[url]").slice(0, 500);
}
function submissionError(message: string, outcome?: "not_submitted" | "rejected"): Error {
  const error = new Error(message) as Error & { submissionOutcome?: "not_submitted" | "rejected" };
  if (outcome) error.submissionOutcome = outcome;
  return error;
}
function isRejectedHttp(status: number): boolean { return [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(status); }
function validHttpUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}必须是 HTTP(S) URL`);
  const text = value.trim();
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error(`${label}必须是 HTTP(S) URL`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`${label}必须是 HTTP(S) URL`);
  return text;
}
function inputImageDataUrl(value: string, index: number): string {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i.exec(value);
  if (!match || match[2].length > Math.ceil(40 * 1024 * 1024 / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(match[2])) throw new Error(`Agent云图像参考素材${index + 1} Data URL 无效或超过 40MB`);
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > 40 * 1024 * 1024) throw new Error(`Agent云图像参考素材${index + 1} Data URL 无效或超过 40MB`);
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  const detected = png ? "image/png" : jpeg ? "image/jpeg" : webp ? "image/webp" : "";
  if (detected !== match[1].toLowerCase().replace("image/jpg", "image/jpeg")) throw new Error(`Agent云图像参考素材${index + 1} MIME 与文件内容不一致`);
  return value;
}
function outputUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().startsWith("asset://")) throw new Error("Agent云视频结果缺少 HTTP(S) URL");
  return validHttpUrl(value, "视频结果");
}
function base64Value(value: unknown, mime: unknown): { outputBase64: string; mimeType: "image/png" | "image/jpeg" } {
  if (typeof value !== "string" || value.length > Math.ceil(40 * 1024 * 1024 / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Agent云图片响应 base64 无效或超过 40MB");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > 40 * 1024 * 1024) throw new Error("Agent云图片响应 base64 无效或超过 40MB");
  const detected: "image/png" | "image/jpeg" | undefined = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png" : bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? "image/jpeg" : undefined;
  if (!detected) throw new Error("Agent云图片响应 base64 不是 PNG/JPEG");
  const normalizedMime = mime === "image/jpg" ? "image/jpeg" : mime;
  if (normalizedMime !== undefined && normalizedMime !== detected) throw new Error("Agent云图片响应 MIME 与文件内容不一致");
  return { outputBase64: value, mimeType: detected };
}
async function requestJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; data: any }> {
  const controller = new AbortController();
  let timer: any;
  const operation = async () => {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
    const text = await response.text();
    let data: any;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Agent云返回了无效 JSON（HTTP ${response.status}）`); }
    return { response, data };
  };
  try {
    return await new Promise<{ response: Response; data: any }>((resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Agent云请求超时")); }, timeoutMs);
      operation().then(resolve, reject);
    });
  } catch (error) { throw new Error(`Agent云请求失败: ${safeError(error)}`); }
  finally { clearTimeout(timer); }
}

function imageReferenceUrl(reference: Reference, index: number): string {
  if (!reference || reference.type !== "image") throw new Error(`Agent云图像参考素材${index + 1}必须是 image`);
  const value = reference.url || reference.base64;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Agent云参考素材${index + 1}缺少 URL`);
  if (/^data:/i.test(value)) {
    return inputImageDataUrl(value, index);
  }
  return validHttpUrl(value, `参考素材${index + 1}`);
}
function videoReferenceUrl(reference: Reference, index: number): string {
  if (!reference || !["image", "video", "audio"].includes(reference.type)) throw new Error(`Agent云视频参考素材${index + 1}类型无效`);
  const value = reference.url || reference.base64;
  if (typeof value !== "string" || /^data:/i.test(value)) throw new Error(`Agent云视频参考素材${index + 1}必须是 HTTP(S) URL，不接受 Data URL`);
  return validHttpUrl(value, `Agent云视频参考素材${index + 1}`);
}
function imageResolution(size: string, ratio: string): string {
  const table: Record<string, [number, number]> = { "1:1": [2048, 2048], "9:16": [1440, 2560], "16:9": [2560, 1440], "3:4": [1728, 2304], "4:3": [2304, 1728], "2:3": [1664, 2496], "3:2": [2496, 1664], "21:9": [3024, 1296] };
  const base = table[ratio];
  if (!base || !["2K", "3K", "4K"].includes(size)) throw new Error("Agent云图像画面比例或尺寸不受支持");
  const scale = size === "2K" ? 1 : size === "3K" ? 1.5 : 2;
  return `${Math.round(base[0] * scale)}x${Math.round(base[1] * scale)}`;
}
function imagePayload(config: ImageConfig, modelName: string): Record<string, unknown> {
  const spec = models[modelName];
  if (!spec || spec.kind !== "image") throw new Error(`未适配的 Agent云图像模型: ${modelName}`);
  if (!spec.resolutions.includes(config.size)) throw new Error(`${modelName} 不支持 ${config.size}，可选：${spec.resolutions.join("、")}`);
  if (typeof config.prompt !== "string" || !config.prompt.trim()) throw new Error("Agent云图像提示词不能为空");
  const refs = config.referenceList || [];
  if (!Array.isArray(refs) || refs.length > 14) throw new Error("Agent云图像参考最多 14 张");
  const image = refs.map((ref, index) => imageReferenceUrl(ref, index));
  if (config.responseFormat !== undefined && !["url", "b64_json"].includes(config.responseFormat)) throw new Error("Agent云图像 response_format 只支持 url 或 b64_json");
  if (config.outputFormat !== undefined && modelName !== "Doubao-Seedream-5.0-Lite") throw new Error("仅 Doubao-Seedream-5.0-Lite 支持 output_format");
  if (config.outputFormat !== undefined && !["png", "jpeg"].includes(config.outputFormat)) throw new Error("Agent云图像 output_format 只支持 png 或 jpeg");
  if (config.seed !== undefined && (!Number.isSafeInteger(config.seed) || config.seed < 0)) throw new Error("Agent云图像 seed 必须是非负安全整数");
  const body: Record<string, unknown> = { model: modelName, prompt: config.prompt.trim(), size: imageResolution(config.size, config.aspectRatio), response_format: config.responseFormat || "url", sequential_image_generation: "disabled", watermark: false };
  if (image.length) body.image = image.length === 1 ? image[0] : image;
  if (config.seed !== undefined) body.seed = config.seed;
  if (modelName === "Doubao-Seedream-5.0-Lite" && config.outputFormat) body.output_format = config.outputFormat;
  return body;
}

const synchronousImageRequest = async (config: ImageConfig, model: ImageModel): Promise<ImageSyncResult> => {
  let body: Record<string, unknown>;
  try { body = imagePayload(config, model.modelName); } catch (error) { throw submissionError(`Agent云图像请求参数无效: ${safeError(error)}`, "not_submitted"); }
  let base: string;
  let apiKey: string;
  try { base = origin(); apiKey = key(); } catch (error) { throw submissionError(`Agent云图像配置无效: ${safeError(error)}`, "not_submitted"); }
  const { response, data } = await requestJson(`${base}${IMAGE_PATH}`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, 295_000);
  if (!response.ok) throw submissionError(`Agent云图像 HTTP ${response.status}: ${safeError(data?.message || data?.error?.message || "请求失败")}`, isRejectedHttp(response.status) ? "rejected" : undefined);
  if (!Array.isArray(data?.data) || data.data.length !== 1) throw new Error("Agent云图像单图协议要求 data 恰好包含 1 张图片");
  const images = data.data.map((item: any) => {
    if (!item || typeof item !== "object") throw new Error("Agent云图像 data 项格式无效");
    const hasUrl = typeof item.url === "string" && item.url.trim().length > 0;
    const hasBase64 = typeof item.b64_json === "string" && item.b64_json.length > 0;
    if (hasUrl === hasBase64) throw new Error("Agent云图像 data 项不得同时或同时缺少 url 与 b64_json");
    if (hasUrl) return { outputUrl: outputUrl(item.url) };
    return base64Value(item.b64_json, item.mime_type);
  });
  return images[0];
};

const synchronousImageRequestLegacy = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  const result = await synchronousImageRequest(config, model);
  return result.outputUrl || `data:${result.mimeType};base64,${result.outputBase64}`;
};

function flattenMode(mode: VideoConfig["mode"]): string[] {
  const top: any[] = Array.isArray(mode) ? mode : [mode];
  if (top.some((item) => !Array.isArray(item) && typeof item !== "string") || top.some((item) => Array.isArray(item) && item.some((child: any) => Array.isArray(child) || typeof child !== "string"))) throw submissionError("Agent云视频 mode 层级或元素无效", "not_submitted");
  if (top.filter(Array.isArray).length > 1) throw submissionError("Agent云视频 mode 不允许多个嵌套参考数组", "not_submitted");
  return top.flatMap((item) => Array.isArray(item) ? item : [item]) as string[];
}
function normalizeVideoMode(mode: VideoConfig["mode"], spec: typeof models[string]): { literal?: string; references?: string[] } {
  const literals = new Set(["text", "singleImage", "startEndRequired", "endFrameOptional"]);
  if (typeof mode === "string") {
    if (!literals.has(mode)) throw submissionError("Agent云视频 mode 无效", "not_submitted");
    return { literal: mode };
  }
  if (!Array.isArray(mode) || mode.length === 0) throw submissionError("Agent云视频 mode 不能为空", "not_submitted");
  if (mode.length === 1 && typeof mode[0] === "string" && literals.has(mode[0])) return { literal: mode[0] };
  const values = flattenMode(mode);
  if (values.length === 0 || values.some((item) => !/^(image|video|audio)Reference:[1-9]\d*$/.test(item)) || new Set(values).size !== values.length) throw submissionError("Agent云视频 mode 必须是单个字面模式或非空的参考声明数组", "not_submitted");
  const declared: Record<MediaType, number> = { image: 0, video: 0, audio: 0 };
  for (const item of values) {
    const match = /^(image|video|audio)Reference:(\d+)$/.exec(item)!;
    const type = match[1] as MediaType;
    const limit = Number(match[2]);
    if (declared[type] || limit > (spec[type] ?? 0)) throw submissionError("Agent云视频 mode 的参考声明超过模型能力或重复", "not_submitted");
    declared[type] = limit;
  }
  return { references: values };
}
function validateVideo(config: VideoConfig, modelName: string): { spec: typeof models[string]; content: any[]; ratio: string } {
  const spec = models[modelName];
  if (!spec || spec.kind !== "video") throw new Error(`未适配的 Agent云视频模型: ${modelName}`);
  if (!Number.isInteger(config.duration) || config.duration < 4 || config.duration > spec.maxDuration!) throw submissionError(`${modelName} 仅支持 4~${spec.maxDuration} 秒整数`, "not_submitted");
  if (!spec.resolutions.includes(config.resolution)) throw new Error(`${modelName} 不支持 ${config.resolution}，可选：${spec.resolutions.join("、")}`);
  if (typeof config.aspectRatio !== "string" || !ratios.has(config.aspectRatio)) throw new Error("Agent云视频画面比例不受支持");
  const refs = config.referenceList || [];
  if (!Array.isArray(refs)) throw new Error("视频参考素材必须是数组");
  const normalizedMode = normalizeVideoMode(config.mode, spec);
  const modeItems = normalizedMode.references ?? [];
  const content: any[] = [];
  const prompt = String(config.prompt || "").trim();
  if (prompt) content.push({ type: "text", text: prompt });
  const counts = { image: 0, video: 0, audio: 0 };
  let frame = false;
  if (normalizedMode.literal === "text") {
    if (refs.length) throw new Error("文生视频模式不接受参考素材");
  } else if (normalizedMode.literal === "singleImage") {
    if (refs.length !== 1 || refs[0].type !== "image") throw new Error("单图模式需要恰好一张图片");
    content.push({ type: "image_url", role: spec.seedance25 ? "first_frame" : "reference_image", image_url: { url: videoReferenceUrl(refs[0], 0) } }); counts.image = 1; frame = Boolean(spec.seedance25);
  } else if (normalizedMode.literal === "startEndRequired" || normalizedMode.literal === "endFrameOptional") {
    if (!spec.seedance25) throw new Error("该 Agent云 2.0 模型未声明首尾帧能力");
    if (refs.length < 1 || refs.length > 2 || refs.some((ref) => ref.type !== "image")) throw new Error("首尾帧模式需要 1~2 张图片");
    if (normalizedMode.literal === "startEndRequired" && refs.length !== 2) throw new Error("首尾帧模式需要两张图片");
    refs.forEach((ref, index) => content.push({ type: "image_url", role: index === 0 ? "first_frame" : "last_frame", image_url: { url: videoReferenceUrl(ref, index) } })); counts.image = refs.length; frame = true;
  } else if (modeItems.some((item) => /^(image|video|audio)Reference:\d+$/.test(item))) {
    const declared: Record<MediaType, number> = { image: 0, video: 0, audio: 0 };
    modeItems.forEach((item) => { const match = item.match(/^(image|video|audio)Reference:(\d+)$/); if (match) declared[match[1] as MediaType] = Number(match[2]); });
    refs.forEach((ref, index) => { if (!ref || !["image", "video", "audio"].includes(ref.type)) throw new Error("视频参考素材类型无效"); counts[ref.type] += 1; if (counts[ref.type] > declared[ref.type] || counts[ref.type] > spec[ref.type]!) throw new Error("视频参考素材超过模型或模式上限"); const type = ref.type; content.push({ type: `${type}_url`, role: `reference_${type}`, [`${type}_url`]: { url: videoReferenceUrl(ref, index) } }); });
  } else if (refs.length) throw new Error("视频模式与参考素材不匹配");
  if (!content.some((item) => ["text", "image_url", "video_url"].includes(item.type))) throw new Error("Agent云视频 content 至少需要 text、image_url 或 video_url");
  if (!spec.seedance25 && counts.audio > 0 && counts.image === 0 && counts.video === 0) throw new Error("Agent云 Seedance 2.0 音频参考不能作为唯一参考");
  return { spec, content, ratio: spec.seedance25 && frame ? "adaptive" : config.aspectRatio };
}

const submitVideoTask = async (config: VideoConfig, model: VideoModel): Promise<VideoSubmitResult> => {
  let validated: ReturnType<typeof validateVideo>;
  try { validated = validateVideo(config, model.modelName); } catch (error) {
    if ((error as any)?.submissionOutcome) throw error;
    throw submissionError(`Agent云视频请求参数无效: ${safeError(error)}`, "not_submitted");
  }
  let base: string;
  let apiKey: string;
  try { base = origin(); apiKey = key(); } catch (error) { throw submissionError(`Agent云视频配置无效: ${safeError(error)}`, "not_submitted"); }
  const { response, data } = await requestJson(`${base}${VIDEO_PATH}/generations`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: model.modelName, content: validated.content, duration: config.duration, ratio: validated.ratio, resolution: config.resolution, generate_audio: config.audio !== false, watermark: false }) }, 55_000);
  if (!response.ok) throw submissionError(`Agent云视频创建 HTTP ${response.status}: ${safeError(data?.message || data?.error?.message || "请求失败")}`, isRejectedHttp(response.status) ? "rejected" : undefined);
  if (typeof data?.task_id !== "string" || !data.task_id.trim()) throw new Error("Agent云视频创建成功响应缺少 task_id");
  return { taskId: data.task_id.trim() };
};
const queryVideoTask = async (taskId: string): Promise<VideoQueryResult> => {
  if (typeof taskId !== "string" || !taskId.trim()) throw new Error("Agent云视频任务 ID 无效");
  const { response, data } = await requestJson(`${origin()}${VIDEO_PATH}/tasks/${encodeURIComponent(taskId.trim())}`, { method: "GET", headers: { Authorization: `Bearer ${key()}` } }, 15_000);
  if (!response.ok) throw submissionError(`Agent云视频查询 HTTP ${response.status}: ${safeError(data?.message || data?.error?.message || "请求失败")}`, isRejectedHttp(response.status) ? "rejected" : undefined);
  const status = String(data?.status || "").toLowerCase();
  if (["queued", "running", "processing", "pending"].includes(status)) return { status: "pending" };
  if (status === "succeeded" || status === "success" || status === "completed") {
    if (!data?.content?.video_url) throw new Error("Agent云视频成功响应缺少 video_url");
    return { status: "succeeded", outputUrl: outputUrl(data.content.video_url) };
  }
  if (["failed", "failure", "cancelled", "canceled", "expired"].includes(status)) return { status: "failed", error: safeError(data?.error?.message || data?.message || `视频任务${status}`) };
  if (data?.error) return { status: "failed", error: safeError(data.error.message || data.error.code || data.error) };
  throw new Error(`Agent云视频返回未知状态: ${status || "<empty>"}`);
};
const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  const submitted = await submitVideoTask(config, model);
  const result = await pollTask(async () => { const queried = await queryVideoTask(submitted.taskId); if (queried.status === "pending") return { completed: false }; return queried.status === "succeeded" ? { completed: true, data: queried.outputUrl } : { completed: true, error: queried.error }; }, 5_000, 30 * 60_000);
  if (!result.data || result.error) throw new Error(result.error || "Agent云视频任务成功但未返回 URL");
  return result.data;
};

exports.vendor = vendor;
exports.synchronousImageRequestVersion = synchronousImageRequestVersion;
exports.synchronousImageRequest = synchronousImageRequest;
exports.imageRequest = synchronousImageRequestLegacy;
exports.submitVideoTask = submitVideoTask;
exports.queryVideoTask = queryVideoTask;
exports.videoRequest = videoRequest;
exports.persistentVideoTaskVersion = persistentVideoTaskVersion;
export {};
