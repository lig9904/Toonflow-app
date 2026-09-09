import { createHash } from "node:crypto";
import { generateText, streamText, wrapLanguageModel, stepCountIs, extractReasoningMiddleware } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import axios from "axios";
import { transform } from "sucrase";
import u from "@/utils";

type AiType =
  | "scriptAgent"
  | "productionAgent"
  | "universalAi"
  | "scriptAgent:decisionAgent"
  | "scriptAgent:supervisionAgent"
  | "scriptAgent:storySkeletonAgent"
  | "scriptAgent:adaptationStrategyAgent"
  | "scriptAgent:scriptAgent"
  | "productionAgent:decisionAgent"
  | "productionAgent:supervisionAgent"
  | "productionAgent:deriveAssetsAgent"
  | "productionAgent:generateAssetsAgent"
  | "productionAgent:directorPlanAgent"
  | "productionAgent:storyboardGenAgent"
  | "productionAgent:storyboardPanelAgent"
  | "productionAgent:storyboardTableAgent";

type FnName = "textRequest" | "imageRequest" | "videoRequest" | "ttsRequest";

const AiTypeValues: AiType[] = [
  "scriptAgent",
  "productionAgent",
  "universalAi",
  "scriptAgent:decisionAgent",
  "scriptAgent:supervisionAgent",
  "scriptAgent:storySkeletonAgent",
  "scriptAgent:adaptationStrategyAgent",
  "scriptAgent:scriptAgent",
  "productionAgent:decisionAgent",
  "productionAgent:supervisionAgent",
  "productionAgent:deriveAssetsAgent",
  "productionAgent:generateAssetsAgent",
  "productionAgent:directorPlanAgent",
  "productionAgent:storyboardGenAgent",
  "productionAgent:storyboardPanelAgent",
  "productionAgent:storyboardTableAgent",
  "universalAi",
];
async function resolveModelName(value: AiType | `${string}:${string}`): Promise<`${string}:${string}`> {
  if (AiTypeValues.includes(value as AiType)) {
    const agentUseModeVal = await u.db("o_setting").where("key", "agentUseMode").first();

    //正常流程
    //高级配置
    if (agentUseModeVal?.value == "1") {
      const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
      if (!agentDeployData?.modelName) throw new Error(`高级配置模式下，未找到对应的模型配置 ${value}`);
      return agentDeployData?.modelName as `${number}:${string}`;
    }
    //简易配置
    if (agentUseModeVal?.value == "0") {
      const [mainly] = value!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`简易配置模式下，未找到部署配置 ${value}`);
      return mainlyData?.modelName as `${number}:${string}`;
    }

    //未查到agentUseModeVal 维持原判断
    const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
    let modelName = null;

    if (!agentDeployData?.modelName) {
      const [mainly] = agentDeployData!.key!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`未找到部署配置 ${value}`);
      modelName = mainlyData.modelName;
    }
    modelName = agentDeployData?.modelName || modelName;
    return modelName as `${number}:${string}`;
  }
  return value as `${number}:${string}`;
}

async function getModelConfig(value: AiType | `${string}:${string}`) {
  if (AiTypeValues.includes(value as AiType)) {
    const agentUseModeVal = await u.db("o_setting").where("key", "agentUseMode").first();
    //正常流程
    //高级配置
    if (agentUseModeVal?.value == "1") {
      const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
      if (!agentDeployData?.modelName) throw new Error(`高级配置模式下，未找到对应的模型配置 ${value}`);
      return agentDeployData;
    }
    //简易配置
    if (agentUseModeVal?.value == "0") {
      const [mainly] = value!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`简易配置模式下，未找到部署配置 ${value}`);
      return mainlyData;
    }

    //未查到 agentUseModelVal 维持原流程
    const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();

    if (!agentDeployData?.modelName) {
      const [mainly] = agentDeployData!.key!.split(/:(.+)/);
      const mainlyData = await u.db("o_agentDeploy").where("key", mainly).first();
      if (!mainlyData?.modelName) throw new Error(`未找到部署配置 ${value}`);
      return mainlyData;
    }
    return agentDeployData;
  }
  return null;
}

interface VendorRuntime {
  id: string;
  selectedModel: any;
  running: any;
  enabled: boolean;
}

async function loadVendorRuntime(modelName: `${string}:${string}`): Promise<VendorRuntime> {
  const [id, name] = modelName.split(/:(.+)/);
  const vendorConfigData = await u.db("o_vendorConfig").where("id", id).first();
  if (!vendorConfigData) throw new Error(`未找到供应商配置 id=${id}`);
  const modelList = await u.vendor.getModelList(id);
  const selectedModel = modelList.find((i: any) => i.modelName == name);
  if (!selectedModel) throw new Error(`未找到模型 ${name} id=${id}`);
  const code = u.vendor.getCode(id);
  const jsCode = transform(code, { transforms: ["typescript"] }).code;
  const running = u.vm(jsCode);
  if (running.vendor) {
    Object.assign(running.vendor.inputValues, JSON.parse(vendorConfigData.inputValues ?? "{}"));
    running.vendor.models = modelList;
  }
  return { id, selectedModel, running, enabled: vendorConfigData.enable === 1 };
}

async function getVendorTemplateFn(
  fnName: "textRequest",
  modelName: `${string}:${string}`,
): Promise<(think?: boolean, thinkLevel?: 0 | 1 | 2 | 3) => any>;
async function getVendorTemplateFn(fnName: Exclude<FnName, "textRequest">, modelName: `${string}:${string}`): Promise<(input: any) => any>;
async function getVendorTemplateFn(fnName: FnName, modelName: `${string}:${string}`): Promise<any> {
  const { id, selectedModel, running } = await loadVendorRuntime(modelName);
  const fn = running[fnName];
  if (!fn) throw new Error(`未找到供应商配置中的函数 ${fnName} id=${id}`);
  if (fnName == "textRequest")
    return (think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0) => {
      const effectiveThink = think ?? !!selectedModel.think;
      return fn(selectedModel, effectiveThink, thinkLevel);
    };
  else return <T>(input: T) => fn(input, selectedModel);
}

export interface PersistentVideoTaskProvider {
  fingerprint: string;
  submit(config: unknown): Promise<{ taskId: string }>;
  query(taskId: string): Promise<{ status: "pending" | "succeeded" | "failed"; outputUrl?: string; error?: string }>;
}

function withPersistentTaskTimeout<T>(operation: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("持久化视频任务适配器超时")), timeoutMs);
    operation().then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}

/**
 * Only adapters that explicitly export submitVideoTask/queryVideoTask can be
 * resumed after process restart. Existing videoRequest-only vendors keep their
 * legacy path and are never misrepresented as recoverable.
 */
export async function getPersistentVideoTaskProvider(key: `${string}:${string}`): Promise<PersistentVideoTaskProvider> {
  const modelName = await resolveModelName(key);
  const { id, selectedModel, running, enabled } = await loadVendorRuntime(modelName);
  if (!enabled) throw new Error(`供应商 ${id} 未启用，不能提交或恢复持久化视频任务`);
  if (id !== "volcengine" || typeof running.submitVideoTask !== "function" || typeof running.queryVideoTask !== "function") {
    throw new Error(`模型 ${modelName} 未提供可恢复的视频任务适配器`);
  }
  const endpoint = String(running.vendor?.inputValues?.baseUrl ?? "").replace(/\/+$/, "");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ vendorId: id, endpoint, modelName: selectedModel.modelName }))
    .digest("hex");
  return {
    fingerprint,
    // The vendor template owns fetch. This bounds the durable worker even if a
    // template's fetch cannot be aborted; a timed-out POST is reconciled, never retried.
    submit: async (config) => withPersistentTaskTimeout(() => running.submitVideoTask(config, selectedModel)),
    query: async (taskId) => withPersistentTaskTimeout(() => running.queryVideoTask(taskId)),
  };
}

async function withTaskRecord<T>(
  modelKey: AiType | `${string}:${string}`,
  taskClass: string,
  describe: string,
  relatedObjects: string,
  projectId: number,
  fn: (modelName: `${string}:${string}`, think: Boolean, thinkLevel: 0 | 1 | 2 | 3) => Promise<T>,
): Promise<T> {
  const modelName = await resolveModelName(modelKey);
  const [_, model] = modelName.split(/:(.+)/);
  const taskRecord = await u.task(projectId, taskClass, model, { describe: describe, content: relatedObjects });
  try {
    const result = await fn(modelName, false, 0);

    taskRecord(1);
    return result;
  } catch (e) {
    taskRecord(-1, u.error(e).message);
    throw new Error(u.error(e).message);
  }
}

async function urlToBase64(url: string, retries = 3, delay = 1000): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { responseType: "arraybuffer" });
      const base64 = Buffer.from(res.data).toString("base64");
      return `${base64}`;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((resolve) => setTimeout(resolve, delay * attempt));
    }
  }
  throw new Error("urlToBase64 failed");
}
class AiText {
  private AiType: AiType | `${string}:${string}`;
  private think?: boolean;
  private thinkLevel: 0 | 1 | 2 | 3;
  constructor(AiType: AiType | `${string}:${string}`, think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0) {
    this.AiType = AiType;
    this.think = think;
    this.thinkLevel = thinkLevel;
  }
  private async resolveModel(middleware?: any | any[]) {
    const switchAiDevTool = await u.db("o_setting").where("key", "switchAiDevTool").first();
    const modelName = await resolveModelName(this.AiType);
    const sdkFn = await getVendorTemplateFn("textRequest", modelName);
    const baseModel = await sdkFn(this.think, this.thinkLevel);
    const mws = [
      ...(switchAiDevTool?.value === "1" ? [devToolsMiddleware()] : []),
      ...(middleware ? (Array.isArray(middleware) ? middleware : [middleware]) : []),
    ];
    return mws.length > 0 ? wrapLanguageModel({ model: baseModel, middleware: mws.length === 1 ? mws[0] : mws }) : baseModel;
  }
  async invoke(input: Omit<Parameters<typeof generateText>[0], "model">) {
    const config = await getModelConfig(this.AiType);

    return generateText({
      ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
      ...input,
      model: await this.resolveModel(),
      ...(config?.temperature && { temperature: config.temperature }),
      ...(config?.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
    } as Parameters<typeof generateText>[0]);
  }
  async stream(input: Omit<Parameters<typeof streamText>[0], "model">) {
    const config = await getModelConfig(this.AiType);

    return streamText({
      ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
      ...input,
      model: await this.resolveModel(extractReasoningMiddleware({ tagName: "reasoning_content", separator: "\n" })),
      ...(config?.temperature && { temperature: config.temperature }),
      ...(config?.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
    } as Parameters<typeof streamText>[0]);
  }
}

function referenceList2imageBase642(id: string, input: any) {
  const version = u.vendor.getVendor(id).version;
  if (!version || isNaN(parseFloat(version)) || parseFloat(version) < 2.0) {
    input.imageBase64 = input.referenceList.map((item: any) => item.base64);
    return input;
  }
  return input;
}

export type ReferenceList = { type: "image"; base64: string } | { type: "audio"; base64: string } | { type: "video"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface TaskRecord {
  taskClass: string; // 任务分类
  describe: string; // 任务描述
  relatedObjects: string; // 相关对象信息，便于后续分析和追踪
  projectId: number; // 项目ID
}

class AiImage {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: ImageConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      const fn = await getVendorTemplateFn("imageRequest", mn);
      await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);
      this.result = await fn(input);
      if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      return this;
    };
    if (taskRecord) {
      await withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
      return this;
    }
    await exec(modelName);
    return this;
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}

type VideoMode =
  | "singleImage" //单图参考
  | "startEndRequired" //首尾帧（两张都得有）
  | "endFrameOptional" //首尾帧（尾帧可选）
  | "startFrameOptional" //首尾帧（首帧可选）
  | "text" //文本
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]; //多参考（数字代表限制数量）

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

class AiVideo {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    try {
      const exec = async (mn: `${string}:${string}`) => {
        const fn = await getVendorTemplateFn("videoRequest", mn);
        await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);

        this.result = await fn(input);

        if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      };
      if (taskRecord) {
        await withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
        return this;
      }
      await exec(modelName);
      return this;
    } catch (e) {
      throw e;
    }
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}
class AiAudio {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      try {
        const fn = await getVendorTemplateFn("ttsRequest", mn);
        await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);
        this.result = await fn(input);

        if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
        return this;
      } catch (e) {}
    };
    if (taskRecord) {
      return withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
    }
    return await exec(modelName);
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}

export default {
  Text: (AiType: AiType | `${string}:${string}`, think?: boolean, thinkLevel?: 0 | 1 | 2 | 3) => new AiText(AiType, think, thinkLevel),
  Image: (key: `${string}:${string}`) => new AiImage(key),
  Video: (key: `${string}:${string}`) => new AiVideo(key),
  Audio: (key: `${string}:${string}`) => new AiAudio(key),
};
