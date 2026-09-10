/**
 * 贞贞模型中转（Seedance NZ）
 *
 * This file is intentionally self-contained: Toonflow's VM provides the
 * globals declared below. It never reads local files or environment variables.
 */
type VideoMode = "singleImage" | "startEndRequired" | "endFrameOptional" | "text" | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];
type MediaType = "image" | "video" | "audio";
type Reference = { type: MediaType; sourceType?: "base64"; base64: string };

interface TextModel { name: string; modelName: string; type: "text"; think: boolean; }
interface ImageModel { name: string; modelName: string; type: "image"; mode: ("text" | "singleImage" | "multiReference")[]; }
interface VideoModel { name: string; modelName: string; type: "video"; mode: VideoMode[]; referenceRatio?: "adaptive"; audio: "optional" | false | true; durationResolutionMap: { duration: number[]; resolution: string[] }[]; }
interface Vendor { id: string; version: string; name: string; author: string; description: string; inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[]; inputValues: Record<string, string>; models: (TextModel | ImageModel | VideoModel)[]; }
interface ImageConfig { prompt: string; referenceList?: Reference[]; size: "1K" | "2K" | "4K"; aspectRatio: `${number}:${number}`; }
interface VideoConfig { duration: number; resolution: string; aspectRatio: `${number}:${number}`; prompt: string; referenceList?: Reference[]; audio?: boolean; mode: VideoMode[] | VideoMode; }
interface PollResult { completed: boolean; data?: string; error?: string; }
interface VideoSubmitResult { taskId: string; }
interface VideoQueryResult { status: "pending" | "succeeded" | "failed"; outputUrl?: string; error?: string; }
interface ImageSubmitResult { taskId: string; }
interface ImageQueryResult { status: "pending" | "succeeded" | "failed"; outputUrl?: string; error?: string; }

declare const axios: any;
declare const createOpenAICompatible: any;
declare const fetch: typeof globalThis.fetch;
declare const FormData: any;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const logger: (message: string) => void;
declare const crypto: any;
declare const Buffer: any;
declare const AbortController: any;
declare const setTimeout: (handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => any;
declare const clearTimeout: (id: any) => void;
declare const exports: any;

const persistentVideoTaskVersion = 1;
const persistentImageTaskVersion = 1;

const vendor: Vendor = {
  id: "zhenzhenRelay",
  version: "2.2",
  name: "贞贞模型中转（Seedance NZ）",
  author: "lig9904",
  description: "贞贞模型中转，预置 8 个文本、4 个 Seedream/Dola 图片、18 个 Seedance 2.0 和 6 个 Seedance 2.5 Standard 视频模型。文本可手动添加本站其他 Chat 模型；其他图片、视频模型需要对应适配。1080p/2k/4k 视频属于该站超分计费档。",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true, placeholder: "Seedance NZ API Key" },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "https://api.seedance.nz" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://api.seedance.nz" },
  models: [
    { name: "DeepSeek V4 Flash", modelName: "deepseek/deepseek-v4-flash", type: "text", think: true },
    { name: "GLM 5.3 Flash", modelName: "glm/glm-5.3-flash", type: "text", think: false },
    { name: "DeepSeek V4 Pro", modelName: "deepseek/deepseek-v4-pro", type: "text", think: true },
    { name: "Qwen 3.8 Flash Next", modelName: "qwen/qwen3.8-flash-next", type: "text", think: true },
    { name: "Qwen 3.8 Max", modelName: "qwen/qwen3.8-max", type: "text", think: true },
    { name: "GK 4.6", modelName: "zhenzhen/gk-4.6", type: "text", think: true },
    { name: "GPT-6 Astra", modelName: "zhenzhen/g6-astra", type: "text", think: true },
    { name: "Kimi K3", modelName: "kimi-k3", type: "text", think: true },
    { name: "Seedream v5 Pro T2I", modelName: "seedream-v5-pro-t2i", type: "image", mode: ["text"] },
    { name: "Seedream v5 Pro I2I", modelName: "seedream-v5-pro-i2i", type: "image", mode: ["singleImage", "multiReference"] },
    { name: "Dola Seedream 5.0 Pro T2I", modelName: "dola-seedream-5.0-pro-t2i", type: "image", mode: ["text"] },
    { name: "Dola Seedream 5.0 Pro I2I", modelName: "dola-seedream-5.0-pro-i2i", type: "image", mode: ["singleImage", "multiReference"] },
    ...videoModels(),
  ],
};

function videoModels(): VideoModel[] {
  const result: VideoModel[] = [];
  const seedance20Durations = Array.from({ length: 12 }, (_value, index) => index + 4);
  const seedance25Durations = Array.from({ length: 27 }, (_value, index) => index + 4);
  for (const globalPrefix of ["", "global-"]) {
    for (const tier of ["standard", "fast", "mini"]) {
      result.push({ name: `Seedance 2.0 ${globalPrefix ? "Global " : ""}${tier} T2V`, modelName: `seedance-2.0-${globalPrefix}${tier}-t2v`, type: "video", mode: ["text"], audio: "optional", durationResolutionMap: [{ duration: seedance20Durations, resolution: ["480p", "720p", "1080p"] }] });
      result.push({ name: `Seedance 2.0 ${globalPrefix ? "Global " : ""}${tier} I2V`, modelName: `seedance-2.0-${globalPrefix}${tier}-i2v`, type: "video", mode: ["endFrameOptional"], audio: "optional", durationResolutionMap: [{ duration: seedance20Durations, resolution: ["480p", "720p", "1080p"] }] });
      result.push({ name: `Seedance 2.0 ${globalPrefix ? "Global " : ""}${tier} Multi`, modelName: `seedance-2.0-${globalPrefix}${tier}-multi`, type: "video", mode: [["imageReference:9", "videoReference:3", "audioReference:3"]], audio: "optional", durationResolutionMap: [{ duration: seedance20Durations, resolution: ["480p", "720p", "1080p"] }] });
    }
    result.push({ name: `Seedance 2.5 ${globalPrefix ? "Global " : ""}Standard T2V`, modelName: `seedance-2.5-${globalPrefix}standard-t2v`, type: "video", mode: ["text"], audio: "optional", durationResolutionMap: [{ duration: seedance25Durations, resolution: ["480p", "720p", "1080p", "2k", "4k", "native1080p"] }] });
    result.push({ name: `Seedance 2.5 ${globalPrefix ? "Global " : ""}Standard I2V`, modelName: `seedance-2.5-${globalPrefix}standard-i2v`, type: "video", mode: ["endFrameOptional"], referenceRatio: "adaptive", audio: "optional", durationResolutionMap: [{ duration: seedance25Durations, resolution: ["480p", "720p", "1080p", "2k", "4k", "native1080p"] }] });
    result.push({ name: `Seedance 2.5 ${globalPrefix ? "Global " : ""}Standard Multi`, modelName: `seedance-2.5-${globalPrefix}standard-multi`, type: "video", mode: [["imageReference:30", "videoReference:10", "audioReference:10"]], audio: "optional", durationResolutionMap: [{ duration: seedance25Durations, resolution: ["480p", "720p", "1080p", "2k", "4k", "native1080p"] }] });
  }
  return result;
}

function baseUrl(): string {
  let parsed: any;
  try { parsed = new URL(vendor.inputValues.baseUrl); } catch { throw new Error("Seedance NZ baseUrl 必须是合法 URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) throw new Error("Seedance NZ baseUrl 只允许不含凭据、查询和片段的 HTTPS origin");
  return parsed.origin;
}
function apiKey(): string {
  const value = String(vendor.inputValues.apiKey || "").trim().replace(/^Bearer\s+/i, "").trim();
  if (!value) throw new Error("缺少 Seedance NZ API Key");
  return value;
}
function headers(json = true): Record<string, string> {
  return { Authorization: `Bearer ${apiKey()}`, ...(json ? { "Content-Type": "application/json" } : {}) };
}
function safeError(error: unknown): string {
  let text = String(error instanceof Error ? error.message : error);
  const key = String(vendor.inputValues.apiKey || "").trim().replace(/^Bearer\s+/i, "").trim();
  if (key) text = text.split(key).join("[redacted]");
  text = text.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").replace(/https?:\/\/[^\s]+/gi, "[url]");
  return text.slice(0, 300);
}
function mediaUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}缺少有效 URL`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} URL 无效`); }
  if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error(`${label} URL 无效`);
  return value;
}
function taskIdentifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("任务 ID 无效");
  return value.trim();
}
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: any;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Seedance NZ 请求超时")); }, Math.max(1, timeoutMs));
  });
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timedOut]); }
  finally { clearTimeout(timer); }
}
async function requestText(url: string, init: RequestInit, timeoutMs = 55_000): Promise<{ response: Response; text: string }> {
  try {
    return await bounded(async (signal) => {
      const response = await fetch(url, { ...init, signal, redirect: "error" });
      const text = await response.text();
      return { response, text };
    }, timeoutMs);
  }
  catch (error) { throw new Error(`Seedance NZ 请求失败: ${safeError(error)}`); }
}
async function jsonRequest(url: string, init: RequestInit, timeoutMs = 55_000): Promise<any> {
  const { response, text } = await requestText(url, init, timeoutMs);
  let data: any;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Seedance NZ 返回了无效 JSON（HTTP ${response.status}）`); }
  if (!response.ok) throw Object.assign(new Error(`Seedance NZ ${response.status}: ${safeError(data?.error?.message || data?.message || text || "请求失败")}`), { httpStatus: response.status });
  return data;
}
function modelKind(modelName: string): "t2v" | "i2v" | "multi" {
  const match = modelName.match(/^seedance-(?:2\.0-(?:global-)?(?:standard|fast|mini)|2\.5-(?:global-)?standard)-(t2v|i2v|multi)$/);
  if (match) return match[1] as "t2v" | "i2v" | "multi";
  throw new Error(`未适配的 Seedance 视频模型: ${modelName}`);
}
function isSeedance25(modelName: string): boolean { return /^seedance-2\.5-(?:global-)?standard-(?:t2v|i2v|multi)$/.test(modelName); }
function validRatio(value: string): boolean { return ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"].includes(value); }
function seconds(value: number, modelName: string): string {
  const max = isSeedance25(modelName) ? 30 : 15;
  if (!Number.isInteger(value) || value < 4 || value > max) throw new Error(`Seedance ${isSeedance25(modelName) ? "2.5" : "2.0"} 时长仅支持 4~${max} 秒整数`);
  return String(value);
}
function dataUrl(value: string): { mime: string; bytes: any } {
  const match = typeof value === "string" ? value.match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/) : null;
  if (!match) throw new Error("参考素材必须是合法 data URL");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(match[2]) || match[2].length % 4 === 1 || (match[2].includes("=") && match[2].length % 4 !== 0)) throw new Error("参考素材 base64 无效");
  if (match[2].length > Math.ceil(50 * 1024 * 1024 / 3) * 4) throw new Error("参考素材超过上传大小限制");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) throw new Error("参考素材 base64 无效");
  return { mime: match[1].toLowerCase(), bytes };
}
const uploadCache = new Map<string, { url: string; expiresAt: number }>();
function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error("Seedance NZ 操作超过 55 秒截止时间");
  return Math.min(55_000, value);
}
async function uploadReference(reference: Reference, index: number, deadline = Date.now() + 55_000, imageLimitBytes = 10 * 1024 * 1024): Promise<string> {
  const { mime, bytes } = dataUrl(reference.base64);
  const isImage = reference.type === "image" && ["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(mime);
  const isVideo = reference.type === "video" && ["video/mp4", "video/avi", "video/quicktime", "video/x-matroska"].includes(mime);
  const isAudio = reference.type === "audio" && ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"].includes(mime);
  if (!isImage && !isVideo && !isAudio) throw new Error(`参考素材${index}媒体类型与 MIME 不匹配或不受支持`);
  const maxBytes = isImage ? imageLimitBytes : 50 * 1024 * 1024;
  if (bytes.length > maxBytes) throw new Error(`参考素材${index}超过${isImage ? Math.round(imageLimitBytes / 1024 / 1024) : 50}MB限制`);
  for (const [entry, value] of uploadCache) if (value.expiresAt <= Date.now() + 60_000) uploadCache.delete(entry);
  const key = crypto.createHash("sha256").update(JSON.stringify([baseUrl(), apiKey(), reference.type, reference.base64])).digest("hex");
  const cached = uploadCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.url;
  const extension = mime.split("/")[1].replace("x-", "") || "bin";
  let data: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    // A multipart stream cannot be reused after a rejected upload attempt.
    const form = new FormData();
    form.append("file", bytes, { filename: `reference-${index}.${extension}`, contentType: mime });
    try {
      const response = await bounded<any>((signal) => axios.post(`${baseUrl()}/v1/files/upload`, form, { headers: { Authorization: `Bearer ${apiKey()}`, ...form.getHeaders() }, signal, timeout: remaining(deadline), maxRedirects: 0, maxBodyLength: 51 * 1024 * 1024, maxContentLength: 1024 * 1024 }), remaining(deadline));
      data = response.data;
      break;
    } catch (error) {
      const response = (error as any)?.response;
      if (Number(response?.status) === 429 && attempt < 2) {
        const value = response.headers?.["retry-after"];
        const seconds = value == null ? NaN : Number(value);
        const parsedDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(String(value)) - Date.now();
        const delay = Math.max(100, Number.isFinite(parsedDelay) ? parsedDelay : 2000 * (attempt + 1));
        if (delay + 1000 < remaining(deadline)) {
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
      throw new Error(`Seedance NZ 素材上传失败（尚未提交视频生成）: ${safeError(error)}`);
    }
  }
  const url = mediaUrl(data?.url, "素材上传结果");
  const expires = data.expires_in === undefined ? 86_400 : Number(data.expires_in);
  if (!Number.isFinite(expires) || expires <= 60) throw new Error("素材上传链接已经或即将过期");
  if (uploadCache.size >= 128) uploadCache.delete(uploadCache.keys().next().value!);
  uploadCache.set(key, { url, expiresAt: Date.now() + Math.min(86_400, expires) * 1000 });
  return url;
}

function validateReferenceSet(refs: Reference[], kind: "image" | "i2v" | "multi", modelName = ""): void {
  if (!Array.isArray(refs) || refs.some((ref) => !ref || !["image", "video", "audio"].includes(ref.type) || (ref.sourceType !== undefined && ref.sourceType !== "base64"))) throw new Error("参考素材类型不合法");
  if (kind === "image") {
    if (refs.some((ref) => ref.type !== "image")) throw new Error("Seedream I2I 只能使用图片参考");
    for (let index = 0; index < refs.length; index++) {
      const info = dataUrl(refs[index].base64);
      if (!/^image\/(jpeg|jpg|png|webp)$/.test(info.mime)) throw new Error(`图片参考${index + 1} MIME 不支持`);
      if (info.bytes.length > 10 * 1024 * 1024) throw new Error(`图片参考${index + 1}超过10MB限制`);
    }
    return;
  }
  if (kind === "i2v") {
    if (refs.length < 1 || refs.length > 2 || refs.some((ref) => ref.type !== "image")) throw new Error("Seedance I2V 需要 1~2 张图片");
    refs.forEach((ref, index) => { const info = dataUrl(ref.base64); if (!/^image\/(jpeg|jpg|png|webp)$/.test(info.mime)) throw new Error(`视频图片参考${index + 1} MIME 不支持`); if (info.bytes.length > 30 * 1024 * 1024) throw new Error(`视频图片参考${index + 1}超过30MB限制`); });
    return;
  }
  if (refs.length < 1) throw new Error("Seedance Multi 至少需要一个参考素材");
  const counts = { image: 0, video: 0, audio: 0 };
  const maxima = isSeedance25(modelName) ? { image: 30, video: 10, audio: 10 } : { image: 9, video: 3, audio: 3 };
  const domesticFast = modelName === "seedance-2.0-fast-multi";
  refs.forEach((ref, index) => {
    counts[ref.type] += 1;
    if (counts.image > maxima.image || counts.video > maxima.video || counts.audio > maxima.audio) throw new Error("Seedance Multi 参考素材数量超限");
    const info = dataUrl(ref.base64);
    if (ref.type === "image") { if (!/^image\/(jpeg|jpg|png|webp)$/.test(info.mime)) throw new Error(`多模态图片参考${index + 1} MIME 不支持`); if (info.bytes.length > 30 * 1024 * 1024) throw new Error(`多模态图片参考${index + 1}超过30MB限制`); }
    if (ref.type === "video") { if (info.mime !== "video/mp4") throw new Error("Seedance Multi 只支持 MP4 参考视频"); if (info.bytes.length > 50 * 1024 * 1024) throw new Error(`多模态视频参考${index + 1}超过50MB限制`); }
    if (ref.type === "audio") { if (!["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"].includes(info.mime)) throw new Error("Seedance Multi 只支持 MP3/WAV 参考音频"); if (info.bytes.length > (domesticFast ? 15 : 50) * 1024 * 1024) throw new Error(`多模态音频参考${index + 1}超过${domesticFast ? 15 : 50}MB限制`); }
  });
}

const textRequest = (model: TextModel, _think: boolean, _thinkLevel: 0 | 1 | 2 | 3) => createOpenAICompatible({ name: "zhenzhenRelay", baseURL: `${baseUrl()}/v1`, apiKey: apiKey() }).chatModel(model.modelName);

const imageModels = new Set(["seedream-v5-pro-t2i", "seedream-v5-pro-i2i", "dola-seedream-5.0-pro-t2i", "dola-seedream-5.0-pro-i2i"]);
function imageDimensions(size: "1K" | "2K", ratio: string): [number, number] {
  const table: Record<string, [number, number]> = { "1:1": [1024, 1024], "16:9": [1280, 720], "9:16": [720, 1280], "4:3": [1152, 864], "3:4": [864, 1152], "21:9": [1512, 648] };
  const base = table[ratio];
  if (!base) throw new Error("Seedream 图片比例不受支持");
  const scale = size === "2K" ? 2 : 1;
  return [base[0] * scale, base[1] * scale];
}
const submitImageTask = async (config: ImageConfig, model: ImageModel): Promise<ImageSubmitResult> => {
  if (!imageModels.has(model.modelName)) throw new Error(`未适配的 Seedream 图片模型: ${model.modelName}`);
  const isI2I = /-i2i$/.test(model.modelName);
  const refs = config.referenceList || [];
  if (!Array.isArray(refs)) throw new Error("参考素材必须是数组");
  if (isI2I && (refs.length < 1 || refs.length > 10)) throw new Error("Seedream 图生图需要 1~10 张图片");
  if (!isI2I && refs.length) throw new Error("Seedream 文生图不接受参考素材");
  validateReferenceSet(refs, "image", model.modelName);
  if (typeof config.prompt !== "string" || config.prompt.trim().length < 5 || config.prompt.length > 2000) throw new Error("Seedream 提示词长度必须为 5~2000 字符");
  if (!["1K", "2K"].includes(config.size)) throw new Error("Seedream 仅支持 1K/2K");
  if (config.size === "4K") throw new Error("Seedream 仅支持 1K/2K");
  const [width, height] = imageDimensions(config.size, config.aspectRatio);
  const deadline = Date.now() + 55_000;
  const images = [];
  for (let index = 0; index < refs.length; index++) images.push(await uploadReference(refs[index], index + 1, deadline, 10 * 1024 * 1024));
  const body: any = { model: model.modelName, prompt: config.prompt, metadata: { width, height, output_format: "jpeg" } };
  if (images.length) body.images = images;
  const created = await jsonRequest(`${baseUrl()}/v1/image/generations`, { method: "POST", headers: headers(), body: JSON.stringify(body) }, remaining(deadline));
  return { taskId: taskIdentifier(created.task_id || created.id) };
};

const queryImageTask = async (input: { taskId: string }): Promise<ImageQueryResult> => {
  const taskId = taskIdentifier(input?.taskId);
  const data = await jsonRequest(`${baseUrl()}/v1/image/generations/${encodeURIComponent(taskId)}`, { method: "GET", headers: headers(false) }, 15_000);
  const task = data.data || data;
  if (["NOT_START", "SUBMITTED", "IN_PROGRESS"].includes(task.status)) return { status: "pending" };
  if (task.status === "SUCCESS") return { status: "succeeded", outputUrl: mediaUrl(task.result_url || task.data?.content?.image_url, "图片结果") };
  if (task.status === "FAILURE") return { status: "failed", error: safeError(task.fail_reason || "图片生成失败") };
  throw new Error("图片任务返回了未知状态");
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  const submitted = await submitImageTask(config, model);
  const result = await pollTask(async () => {
    const queried = await queryImageTask({ taskId: submitted.taskId });
    if (queried.status === "pending") return { completed: false };
    if (queried.status === "succeeded") return { completed: true, data: queried.outputUrl };
    return { completed: true, error: queried.error || "图片生成失败" };
  }, 3_000, 30 * 60_000);
  if (result.error || !result.data) throw new Error(result.error || "图片任务成功但未返回 URL");
  return result.data;
};

const submitVideoTask = async (config: VideoConfig, model: VideoModel): Promise<VideoSubmitResult> => {
  let generationRequestStarted = false;
  try {
    const deadline = Date.now() + 55_000;
    const kind = modelKind(model.modelName);
    let modeItems: any[] = Array.isArray(config.mode) ? config.mode : [config.mode];
    if (modeItems.length === 1 && Array.isArray(modeItems[0])) modeItems = modeItems[0];
    if (kind === "t2v" && (modeItems.length !== 1 || modeItems[0] !== "text")) throw new Error("Seedance T2V mode 与模型后缀不匹配");
    if (kind === "i2v" && (modeItems.length !== 1 || !["singleImage", "startEndRequired", "endFrameOptional"].includes(modeItems[0]))) throw new Error("Seedance I2V mode 与模型后缀不匹配");
    if (kind === "multi" && (!modeItems.length || modeItems.some((item) => typeof item !== "string" || !/^(image|video|audio)Reference:[1-9]\d*$/.test(item)))) throw new Error("Seedance Multi mode 与模型后缀不匹配");
    if (!validRatio(config.aspectRatio)) throw new Error("不支持的视频画面比例");
    const prompt = String(config.prompt || "").trim();
    if (kind !== "i2v" && !prompt) throw new Error("文生视频/多模态视频必须提供 prompt");
    if (prompt.length > 20_480) throw new Error("Seedance prompt 最长 20480 字符");
    const refs = config.referenceList || [];
    if (!Array.isArray(refs)) throw new Error("参考素材必须是数组");
    // Seedance 2.5 keyframes follow the reference image. Use the relay's
    // documented adaptive default rather than forcing a second fixed ratio.
    const ratio = kind === "i2v" && isSeedance25(model.modelName) ? "adaptive" : config.aspectRatio;
    const body: any = { model: model.modelName, prompt, seconds: seconds(config.duration, model.modelName), metadata: { resolution: config.resolution, ratio, generate_audio: config.audio !== false } };
    const resolutions = isSeedance25(model.modelName) ? ["480p", "720p", "1080p", "2k", "4k", "native1080p"] : ["480p", "720p", "1080p"];
    if (!resolutions.includes(config.resolution)) throw new Error(`Seedance ${isSeedance25(model.modelName) ? "2.5" : "2.0"} 分辨率不受支持`);
    if (kind === "t2v") {
      if (refs.length) throw new Error("Seedance T2V 不接受参考素材");
    } else if (kind === "i2v") {
      validateReferenceSet(refs, "i2v", model.modelName);
      if (modeItems[0] === "singleImage" && refs.length !== 1) throw new Error("单图模式需要恰好一张首帧图");
      if (modeItems[0] === "startEndRequired" && refs.length !== 2) throw new Error("首尾帧模式需要恰好两张图片");
      body.images = [];
      for (let index = 0; index < refs.length; index++) body.images.push(await uploadReference(refs[index], index + 1, deadline, 30 * 1024 * 1024));
    } else {
      validateReferenceSet(refs, "multi", model.modelName);
      const maxima = isSeedance25(model.modelName) ? { image: 30, video: 10, audio: 10 } : { image: 9, video: 3, audio: 3 };
      const limits: Record<string, number> = {};
      for (const item of modeItems) {
        const [type, limit] = item.split("Reference:");
        const maximum = maxima[type as keyof typeof maxima];
        if (limits[type] !== undefined || Number(limit) > maximum) throw new Error("多参考模式数量配置无效");
        limits[type] = Number(limit);
      }
      for (const type of ["image", "video", "audio"]) if (refs.filter((ref) => ref.type === type).length > (limits[type] ?? 0)) throw new Error("参考素材与所选模式不匹配");
      const counts = { image: 0, video: 0, audio: 0 };
      body.metadata.content = [];
      for (let index = 0; index < refs.length; index++) {
        const ref = refs[index]; counts[ref.type] += 1;
        const url = await uploadReference(ref, index + 1, deadline, 30 * 1024 * 1024);
        const label = ref.type === "image" ? "Image" : ref.type === "video" ? "Video" : "Audio";
        const number = counts[ref.type];
        body.prompt = body.prompt
          .replace(new RegExp(`@${label}\\s*${number}(?!\\d)`, "g"), `@${label} ${number}`)
          .replace(new RegExp(`@${ref.type === "image" ? "图片" : ref.type === "video" ? "视频" : "音频"}\\s*${number}(?!\\d)`, "g"), `@${label} ${number}`);
        body.metadata.content.push({ type: `${ref.type}_url`, [`${ref.type}_url`]: { url } });
      }
    }
    const requestHeaders = headers();
    const requestBody = JSON.stringify(body);
    const timeout = remaining(deadline);
    generationRequestStarted = true;
    const response = await jsonRequest(`${baseUrl()}/v1/videos`, { method: "POST", headers: requestHeaders, body: requestBody }, timeout);
    const taskId = taskIdentifier(response.id || response.task_id);
    return { taskId };
  } catch (error) {
    if (!generationRequestStarted) throw Object.assign(new Error(safeError(error)), { submissionOutcome: "not_submitted" });
    const status = Number((error as any)?.httpStatus);
    if ([400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(status)) {
      throw Object.assign(new Error(safeError(error)), { submissionOutcome: "rejected" });
    }
    // A lost response or a successful response without an ID stays uncertain.
    throw error;
  }
};

const queryVideoTask = async (taskId: string): Promise<VideoQueryResult> => {
  taskId = taskIdentifier(taskId);
  const task = await jsonRequest(`${baseUrl()}/v1/videos/${encodeURIComponent(taskId)}`, { method: "GET", headers: headers(false) }, 15_000);
  if (task.status === "queued" || task.status === "in_progress") return { status: "pending" };
  if (task.status === "completed") {
    return { status: "succeeded", outputUrl: mediaUrl(task.metadata?.url, "视频结果") };
  }
  if (task.status === "failed") return { status: "failed", error: safeError(task.error?.message || "视频生成失败") };
  throw new Error("视频任务返回了未知状态");
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  const submitted = await submitVideoTask(config, model);
  const result = await pollTask(async () => { const queried = await queryVideoTask(submitted.taskId); if (queried.status === "pending") return { completed: false }; if (queried.status === "succeeded") return { completed: true, data: queried.outputUrl }; return { completed: true, error: queried.error || "视频生成失败" }; }, 3_000, 30 * 60_000);
  if (result.error || !result.data) throw new Error(result.error || "视频任务成功但未返回 URL");
  return result.data;
};

const ttsRequest = async (_config: any, _model: any): Promise<string> => { throw new Error("贞贞模型中转暂不支持 TTS"); };

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.submitImageTask = submitImageTask;
exports.queryImageTask = queryImageTask;
exports.videoRequest = videoRequest;
exports.submitVideoTask = submitVideoTask;
exports.queryVideoTask = queryVideoTask;
exports.ttsRequest = ttsRequest;
exports.persistentVideoTaskVersion = persistentVideoTaskVersion;
exports.persistentImageTaskVersion = persistentImageTaskVersion;

export {};
