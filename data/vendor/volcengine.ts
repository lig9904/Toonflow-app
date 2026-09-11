/**
 * 火山方舟标准按量语言接口。媒体模型位于 volcengineSd2。
 * 目录与能力核对：2026-09-11
 * https://www.volcengine.com/docs/82379/1330310
 * https://www.volcengine.com/docs/82379/1449737
 * @version 3.0
 */
interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
  thinkingMode?: "optional" | "required";
  maxOutputTokens: number;
  provider: string;
}
declare const createOpenAICompatible: any;
declare const withVolcengineChatCompatibility: (model: any) => any;
declare const exports: Record<string, any>;
const textModel = (name: string, modelName: string, provider: string, maxOutputTokens: number, required = false): TextModel => ({
  name, modelName, provider, type: "text", think: true, thinkingMode: required ? "required" : "optional", maxOutputTokens,
});
const vendor = {
  id: "volcengine",
  version: "3.0",
  author: "leeqi",
  name: "火山引擎(豆包)",
  description: "火山方舟标准按量语言接口，覆盖字节跳动、DeepSeek、智谱的最新产品线型号。图片、视频请使用火山引擎sd2.0真人。\n\nGLM 5.3 Flash 始终启用思考，关闭思考时使用其最低思考档位。使用方舟 API Key；订阅 Agent/Coding Plan 型号不适用于此入口。",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true, placeholder: "火山方舟 API Key" },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "https://ark.cn-beijing.volces.com/api/v3" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  models: [
    textModel("Doubao Seed 2.1 Pro", "doubao-seed-2-1-pro-260628", "字节跳动", 256000),
    textModel("Doubao Seed 2.1 Turbo", "doubao-seed-2-1-turbo-260628", "字节跳动", 256000),
    textModel("Doubao Seed Evolving", "doubao-seed-evolving", "字节跳动", 256000),
    // Lite、Mini、Code、Character 各自保留最新版本，不能用旗舰版本号替代它们。
    textModel("Doubao Seed 2.0 Lite", "doubao-seed-2-0-lite-260428", "字节跳动", 128000),
    textModel("Doubao Seed 2.0 Mini", "doubao-seed-2-0-mini-260428", "字节跳动", 128000),
    textModel("Doubao Seed 2.0 Code", "doubao-seed-2-0-code-preview-260215", "字节跳动", 128000),
    textModel("Doubao Seed Character", "doubao-seed-character-260628", "字节跳动", 32000),
    textModel("DeepSeek V4 Pro 正式版", "deepseek-v4-pro-ga-260813", "DeepSeek", 384000),
    textModel("DeepSeek V4 Flash 正式版", "deepseek-v4-flash-ga-260731", "DeepSeek", 384000),
    textModel("GLM 5.2", "glm-5-2-260617", "智谱AI", 128000),
    textModel("GLM 5.3 Flash（始终思考）", "glm-5-3-flash-260828", "智谱AI", 128000, true),
  ],
};

const getBaseUrl = () => {
  const value = String(vendor.inputValues.baseUrl || "").trim().replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("请填写有效的火山方舟请求地址"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/api/v3")) {
    throw new Error("火山方舟请求地址须以 /api/v3 结束，不能包含密钥、查询参数或片段");
  }
  return value;
};

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  const apiKey = String(vendor.inputValues.apiKey || "").trim().replace(/^Bearer(?:\s+|$)/i, "").trim();
  if (!apiKey) throw new Error("缺少火山方舟 API Key");
  const level = Number.isInteger(thinkLevel) && thinkLevel >= 0 && thinkLevel <= 3 ? thinkLevel : 0;
  const required = model.thinkingMode === "required" || model.modelName === "glm-5-3-flash-260828";
  const thinking = required || Boolean(think);
  // 等级 0 表示最低的开启档位；不能传 minimal，否则豆包会关闭思考。
  const effort = model.modelName.startsWith("deepseek-v4-") ? ["low", "low", "high", "max"][level]
    : model.modelName.startsWith("glm-5-3-") ? ["low", "low", "high", "max"][level]
    : model.modelName.startsWith("glm-5-2-") ? ["high", "high", "high", "max"][level]
    : ["low", "low", "medium", "high"][level];
  return withVolcengineChatCompatibility(createOpenAICompatible({
    name: "volcengine",
    includeUsage: true,
    baseURL: getBaseUrl(),
    apiKey,
    fetch: async (url: string, options?: RequestInit) => {
      if (typeof options?.body !== "string") return fetch(url, options);
      const body = JSON.parse(options.body);
      body.thinking = { type: thinking ? "enabled" : "disabled" };
      if (thinking) body.reasoning_effort = required && !think ? "low" : effort;
      else delete body.reasoning_effort;
      // AI SDK maxOutputTokens 是整个请求的预算，包含推理；不能只限制回答正文。
      if (body.max_tokens !== undefined && body.max_completion_tokens === undefined) {
        body.max_completion_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      if (Number.isFinite(body.max_completion_tokens) && model.maxOutputTokens) {
        body.max_completion_tokens = Math.min(body.max_completion_tokens, model.maxOutputTokens);
      }
      return fetch(url, { ...options, body: JSON.stringify(body) });
    },
  }).chatModel(model.modelName));
};
exports.vendor = vendor;
exports.textRequest = textRequest;
const mediaUnsupported = async () => { throw new Error("此供应商仅保留语言模型，图片和视频请使用火山引擎sd2.0真人"); };
exports.imageRequest = mediaUnsupported;
exports.videoRequest = mediaUnsupported;
exports.ttsRequest = mediaUnsupported;
