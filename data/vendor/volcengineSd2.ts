/**
 * Toonflow 火山官方图片和视频适配器（保留原 sd2.0 真人供应商标识）
 * @version 3.1
 */

// ============================================================
// 类型定义
// ============================================================

type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
  resolutions?: ("1K" | "1.5K" | "2K" | "3K" | "4K")[];
  maxReferenceImages?: number;
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
  aspectRatios?: ("16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9" | "adaptive")[];
  referenceTransport?: "url";
  referenceRatio?: "adaptive";
}

interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}

interface VendorConfig {
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  icon?: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}

type ReferenceList =
  | { type: "image"; sourceType?: "base64" | "url"; base64?: string; url?: string }
  | { type: "audio"; sourceType?: "base64" | "url"; base64?: string; url?: string }
  | { type: "video"; sourceType?: "base64" | "url"; base64?: string; url?: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "1.5K" | "2K" | "3K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9" | "adaptive";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode;
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ============================================================
// 全局声明
// ============================================================

declare const axios: any;
declare const jsonwebtoken: any;
declare const zipImage: (base64: string, size: number) => Promise<string>;
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>;
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const createOpenAI: any;
declare const createDeepSeek: any;
declare const createZhipu: any;
declare const createQwen: any;
declare const createAnthropic: any;
declare const createOpenAICompatible: any;
declare const createXai: any;
declare const createMinimax: any;
declare const createGoogleGenerativeAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  submitVideoTask: (c: VideoConfig, m: VideoModel) => Promise<{ taskId: string }>;
  queryVideoTask: (taskId: string) => Promise<{ status: "pending" | "succeeded" | "failed"; outputUrl?: string; error?: string }>;
  persistentVideoTaskVersion: 1;
  synchronousImageRequestVersion: 1;
  synchronousImageRequest: (c: ImageConfig, m: ImageModel) => Promise<{ outputUrl: string }>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

// ============================================================
// 供应商配置
// ============================================================

const vendor: VendorConfig = {
  id: "volcengineSd2",
  version: "3.1",
  author: "toonflow",
  name: "火山引擎sd2.0真人",
  description: "使用火山方舟官方图片与视频生成 API。图片生成参考可从 NAS 读取为 Base64；视频生成参考使用应用现有的签名媒体 URL，无需 TOS。真人素材须先在方舟可信素材库完成真人认证与授权，再以 asset:// Asset ID 使用；本适配器不自动上传或注册真人素材。",
  icon: "",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true, placeholder: "火山引擎API Key" },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "以v3结束，示例：https://ark.cn-beijing.volces.com/api/v3" },
    { key: "ak", label: "旧版 Access Key（不再使用）", type: "text", required: false },
    { key: "sk", label: "旧版 Secret Key（不再使用）", type: "password", required: false },
    { key: "groupId", label: "旧版资产组 ID（不再使用）", type: "text", required: false },
    { key: "tosEndpoint", label: "旧版 TOS Endpoint（不再使用）", type: "url", required: false },
    { key: "tosBucket", label: "旧版 TOS Bucket（不再使用）", type: "text", required: false },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    ak: "",
    sk: "",
    groupId: "",
    tosEndpoint: "",
    tosBucket: "",
  },
  models: [
    {
      name: "Seedream-5.0-Pro",
      modelName: "doubao-seedream-5-0-pro-260628",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      resolutions: ["1K", "1.5K", "2K"],
      maxReferenceImages: 10,
    },
    {
      name: "Seedream-5.0-Lite",
      modelName: "doubao-seedream-5-0-lite-260128",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      resolutions: ["2K", "3K", "4K"],
      maxReferenceImages: 14,
    },
    {
      name: "Seedream-4.5",
      modelName: "doubao-seedream-4-5-251128",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      resolutions: ["2K", "4K"],
      maxReferenceImages: 14,
    },
    {
      name: "Seedream-4.0",
      modelName: "doubao-seedream-4-0-250828",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      resolutions: ["1K", "2K", "4K"],
      maxReferenceImages: 14,
    },
    {
      name: "Seedance-2.5(音画同生)",
      modelName: "doubao-seedance-2-5-260628",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:30", "videoReference:10", "audioReference:10"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480p", "720p", "1080p"] }],
      aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
      referenceTransport: "url",
      referenceRatio: "adaptive",
    },
    {
      name: "Seedance-2.0(音画同生)",
      modelName: "doubao-seedance-2-0-260128",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p", "4k"] }],
      aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
      referenceTransport: "url",
      referenceRatio: "adaptive",
    },
    {
      name: "Seedance-2.0-Fast(音画同生)",
      modelName: "doubao-seedance-2-0-fast-260128",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
      aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
      referenceTransport: "url",
      referenceRatio: "adaptive",
    },
    {
      name: "Seedance-2.0-Mini(音画同生)",
      modelName: "doubao-seedance-2-0-mini-260615",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional", "startEndRequired", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p"] }],
      aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
      referenceTransport: "url",
      referenceRatio: "adaptive",
    },
  ],
};
// 辅助工具
// ============================================================

const getHeaders = () => {
  const apiKey = String(vendor.inputValues.apiKey || "").trim().replace(/^Bearer\s+/i, "");
  if (!apiKey) throw notSubmitted("缺少API Key");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
};

const getBaseUrl = () => String(vendor.inputValues.baseUrl || "").trim().replace(/\/+$/, "") || "https://ark.cn-beijing.volces.com/api/v3";
const notSubmitted = (message: string) => Object.assign(new Error(message), { submissionOutcome: "not_submitted" as const });
const rejected = (message: string) => Object.assign(new Error(message), { submissionOutcome: "rejected" as const });
const safeUpstreamError = (value: unknown): string => {
  let text = String(value ?? "");
  const configuredSecrets = [vendor.inputValues.apiKey, vendor.inputValues.ak, vendor.inputValues.sk].flatMap((item) => {
    const raw = String(item || "").trim(); return [raw, raw.replace(/^Bearer\s+/i, "")];
  }).filter((item) => item.length >= 4);
  for (const secret of configuredSecrets) text = text.split(secret).join("[REDACTED]");
  return text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:X-Tos-[^=]+|Signature|token|access[_-]?key|secret[_-]?key)=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:AK|SK)[A-Za-z0-9_\-]{8,}\b/g, "[REDACTED]").slice(0, 500);
};
const responseFailure = async (response: Response, operation: string) => {
  let code = "", message = "";
  try {
    const body = await response.json();
    code = safeUpstreamError(body?.error?.code ?? body?.code);
    message = safeUpstreamError(body?.error?.message ?? body?.message);
  } catch { /* HTTP status remains sufficient and no raw body is persisted. */ }
  const detail = [code, message].filter(Boolean).join(": ");
  const summary = `${operation}（HTTP ${response.status}${detail ? `，${detail}` : ""}）`;
  return response.status >= 400 && response.status < 500 && response.status !== 408 ? rejected(summary) : new Error(`${summary}，提交结果不确定`);
};
const referenceValue = (reference: ReferenceList): string => {
  const value = String(reference.url ?? reference.base64 ?? "").trim();
  if (!value) throw notSubmitted("参考素材缺少 URL、Base64 或已授权 asset:// ID");
  return value;
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {};

const synchronousImageRequest = async (config: ImageConfig, model: ImageModel): Promise<{ outputUrl: string }> => {
  const references = config.referenceList ?? [];
  if (model.maxReferenceImages && references.length > model.maxReferenceImages) throw notSubmitted(`当前模型最多支持 ${model.maxReferenceImages} 张参考图`);
  if (model.resolutions && !model.resolutions.includes(config.size)) throw notSubmitted(`当前模型不支持 ${config.size}，可选：${model.resolutions.join("、")}`);
  const ratioInstruction = config.aspectRatio ? `输出图片宽高比：${config.aspectRatio}` : "";
  const body: any = { model: model.modelName, prompt: [config.prompt || "", ratioInstruction].filter(Boolean).join("\n"), response_format: "url", watermark: false };
  if (!model.modelName.includes("seedream-5-0-pro")) body.sequential_image_generation = "disabled";
  if (references.length) {
    const images = references.map(referenceValue);
    body.image = images.length === 1 ? images[0] : images;
  }
  body.size = config.size;
  const response = await fetch(`${getBaseUrl()}/images/generations`, { method: "POST", headers: getHeaders(), body: JSON.stringify(body) });
  if (!response.ok) throw await responseFailure(response, "图片生成请求");
  const result = await response.json();
  if (result?.error) throw rejected(`图片生成被上游拒绝（${[safeUpstreamError(result.error.code), safeUpstreamError(result.error.message)].filter(Boolean).join(": ") || "未知原因"}）`);
  if (!Array.isArray(result?.data) || result.data.length !== 1 || typeof result.data[0]?.url !== "string" || !result.data[0].url.trim()) throw new Error("图片生成已请求但未返回唯一图片 URL");
  return { outputUrl: result.data[0].url.trim() };
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  const result = await synchronousImageRequest(config, model);
  return urlToBase64(result.outputUrl);
};

const submitVideoTask = async (config: VideoConfig, model: VideoModel): Promise<{ taskId: string }> => {
  const baseUrl = getBaseUrl();
  const headers = getHeaders();
  if (!model.durationResolutionMap.some((entry) => entry.duration.includes(config.duration) && entry.resolution.includes(config.resolution))) throw notSubmitted("视频时长与分辨率组合不受当前模型支持");
  if (model.aspectRatios && !model.aspectRatios.includes(config.aspectRatio)) throw notSubmitted("视频宽高比不受当前模型支持");
  const selectedMode = model.mode.find((allowed) => JSON.stringify(allowed) === JSON.stringify(config.mode));
  if (selectedMode === undefined) throw notSubmitted("视频生成模式不受当前模型支持");
  const providedReferences = config.referenceList ?? [];
  if (config.mode === "text" && providedReferences.length) throw notSubmitted("文生视频模式不能携带参考素材");
  if (config.mode === "singleImage" && (providedReferences.length !== 1 || providedReferences[0].type !== "image")) throw notSubmitted("单图首帧模式必须且只能提供一张图片");
  if (config.mode === "endFrameOptional" && (providedReferences.length < 1 || providedReferences.length > 2 || providedReferences.some((item) => item.type !== "image"))) throw notSubmitted("首帧加可选尾帧模式只能提供一至两张图片");
  if (config.mode === "startEndRequired" && (providedReferences.length !== 2 || providedReferences.some((item) => item.type !== "image"))) throw notSubmitted("首尾帧模式必须且只能提供两张图片");

  const content: any[] = [];

  if (config.prompt) {
    content.push({ type: "text", text: config.prompt });
  }

  if (typeof config.mode === "string") {
    switch (config.mode) {
      case "singleImage": {
        const firstImage = config.referenceList?.find((r) => r.type === "image");
        if (firstImage) {
          content.push({
            type: "image_url",
            image_url: { url: referenceValue(firstImage) },
            role: "first_frame",
          });
        } else throw notSubmitted("单图首帧模式缺少首帧图片");
        break;
      }
      case "startFrameOptional": {
        const images = config.referenceList?.filter((r) => r.type === "image") ?? [];
        if (images.length > 0) {
          content.push({
            type: "image_url",
            image_url: { url: referenceValue(images[0]) },
            role: "first_frame",
          });
          if (images.length > 1) {
            content.push({
              type: "image_url",
              image_url: { url: referenceValue(images[1]) },
              role: "last_frame",
            });
          }
        } else throw notSubmitted("首帧模式缺少首帧图片");
        break;
      }
      case "startEndRequired": {
        const images = config.referenceList?.filter((r) => r.type === "image") ?? [];
        if (images.length >= 2) {
          content.push({
            type: "image_url",
            image_url: { url: referenceValue(images[0]) },
            role: "first_frame",
          });
          content.push({
            type: "image_url",
            image_url: { url: referenceValue(images[1]) },
            role: "last_frame",
          });
        } else throw notSubmitted("首尾帧模式必须提供两张图片");
        break;
      }
      case "endFrameOptional": {
        const images = config.referenceList?.filter((r) => r.type === "image") ?? [];
        if (images.length > 0) {
          content.push({
            type: "image_url",
            image_url: { url: referenceValue(images[0]) },
            role: "first_frame",
          });
          if (images.length > 1) {
            content.push({
              type: "image_url",
              image_url: { url: referenceValue(images[1]) },
              role: "last_frame",
            });
          }
        }
        break;
      }
      case "text":
        break;
      default:
        throw notSubmitted("无法识别视频生成模式");
    }
  } else if (Array.isArray(config.mode)) {
    // 多模态参考模式：按类型分别提取并添加
    const imageRefs = config.referenceList?.filter((r) => r.type === "image") ?? [];
    const videoRefs = config.referenceList?.filter((r) => r.type === "video") ?? [];
    const audioRefs = config.referenceList?.filter((r) => r.type === "audio") ?? [];

    const selectedReferences = selectedMode as ("videoReference:${number}" | "imageReference:${number}" | "audioReference:${number}")[];
    const declaredLimit = (type: "image" | "video" | "audio") => {
      const value = selectedReferences.find((entry) => entry.startsWith(`${type}Reference:`));
      return value ? Number(value.split(":")[1]) : 0;
    };
    for (const [type, refs] of [["image", imageRefs], ["video", videoRefs], ["audio", audioRefs]] as const) {
      if (refs.length > declaredLimit(type)) throw notSubmitted(`当前模型 ${type} 参考数量超过官方上限`);
    }
    if (/seedance-2-0(?:-|$)/.test(model.modelName) && !imageRefs.length && !videoRefs.length && audioRefs.length) throw notSubmitted("Seedance 2.0 系列不能仅输入音频参考，至少需要一张图片或一个视频");
    for (const refDef of selectedReferences) {
      if (typeof refDef === "string") {
        if (refDef.startsWith("imageReference:")) {
          const maxCount = parseInt(refDef.split(":")[1], 10);

          for (const ref of imageRefs.slice(0, maxCount)) {
            content.push({
              type: "image_url",
              image_url: { url: referenceValue(ref) },
              role: "reference_image",
            });
          }
        } else if (refDef.startsWith("videoReference:")) {
          const maxCount = parseInt(refDef.split(":")[1], 10);
          for (const ref of videoRefs.slice(0, maxCount)) {
            const url = referenceValue(ref);
            if (!/^(?:https?:\/\/|asset:\/\/)/i.test(url)) throw notSubmitted("视频参考仅支持公网 HTTP(S) URL 或已授权 asset:// ID，不支持 Base64");
            content.push({
              type: "video_url",
              video_url: { url },
              role: "reference_video",
            });
          }
        } else if (refDef.startsWith("audioReference:")) {
          const maxCount = parseInt(refDef.split(":")[1], 10);
          for (const ref of audioRefs.slice(0, maxCount)) {
            content.push({
              type: "audio_url",
              audio_url: { url: referenceValue(ref) },
              role: "reference_audio",
            });
          }
        }
      }
    }
  }
  const body: any = {
    model: model.modelName,
    content,
    duration: config.duration,
    resolution: config.resolution || "720p",
    watermark: false,
  };
  // First-frame generation inherits its aspect ratio from the supplied frame.
  // Ark rejects an explicit ratio for first-frame and first-last-frame tasks.
  if (config.mode === "text" || Array.isArray(config.mode)) body.ratio = config.aspectRatio;
  if (Array.isArray(config.mode) && model.modelName.includes("seedance-2-5")) body.omni_reference_task_type = "reference";

  if (model.audio === "optional") {
    body.generate_audio = config.audio !== false;
  } else if (model.audio === true) {
    body.generate_audio = true;
  } else {
    body.generate_audio = false;
  }
  const res = await fetch(`${baseUrl}/contents/generations/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) throw await responseFailure(res, "视频生成任务创建");
  const createResponse = await res.json();
  const taskId = createResponse?.id;

  if (!taskId) {
    throw new Error("视频生成任务创建失败：未返回任务ID");
  }

  return { taskId };
};

const queryVideoTask = async (taskId: string): Promise<{ status: "pending" | "succeeded" | "failed"; outputUrl?: string; error?: string }> => {
  if (typeof taskId !== "string" || !taskId.trim()) throw new Error("视频任务 ID 无效");
  const queryRes = await fetch(`${getBaseUrl()}/contents/generations/tasks/${encodeURIComponent(taskId.trim())}`, { method: "GET", headers: getHeaders() });
  if (!queryRes.ok) throw await responseFailure(queryRes, "查询视频生成任务");
  const task = await queryRes.json();
  if (task.status === "succeeded") return task.content?.video_url ? { status: "succeeded", outputUrl: task.content.video_url } : { status: "failed", error: "任务成功但未返回视频URL" };
  if (task.status === "failed") return { status: "failed", error: safeUpstreamError(task.error?.message) || "视频生成失败" };
  if (task.status === "expired") return { status: "failed", error: "视频生成任务超时" };
  if (task.status === "cancelled") return { status: "failed", error: "视频生成任务已取消" };
  return { status: "pending" };
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  const { taskId } = await submitVideoTask(config, model);
  const result = await pollTask(async (): Promise<PollResult> => {
    const task = await queryVideoTask(taskId);
    return task.status === "pending" ? { completed: false } : task.status === "succeeded" ? { completed: true, data: task.outputUrl } : { completed: true, error: task.error };
  }, 10000, 600000 * 3);
  if (result.error) throw new Error(result.error);
  return result.data!;
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "3.1", notice: "" };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================

exports.vendor = vendor;
exports.persistentVideoTaskVersion = 1;
exports.synchronousImageRequestVersion = 1;
exports.synchronousImageRequest = synchronousImageRequest;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.submitVideoTask = submitVideoTask;
exports.queryVideoTask = queryVideoTask;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

export {};
