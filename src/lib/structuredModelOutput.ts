import { NoObjectGeneratedError, NoOutputGeneratedError } from "ai";
import type { z } from "zod";

export interface StructuredOutputDiagnostics {
  role: string;
  finishReason: string;
  maxOutputTokens: number;
  outputTokens?: number;
  reasoningTokens?: number;
  textCharacters: number;
}

export type StructuredOutputErrorCode = "MODEL_OUTPUT_LIMIT" | "MODEL_OUTPUT_FORMAT" | "MODEL_OUTPUT_FILTERED" | "MODEL_OUTPUT_INCOMPLETE";

const labels: Record<string, string> = {
  "productionAgent:decisionAgent": "制作规划", "productionAgent:directorPlanAgent": "导演计划",
  "productionAgent:deriveAssetsAgent": "衍生素材分析", "productionAgent:storyboardTableAgent": "分镜生成",
  "productionAgent:supervisionAgent": "制作审核", "scriptAgent:decisionAgent": "剧本规划",
  "scriptAgent:scriptAgent": "剧本生成", universalAi: "内容分析",
};

/** Contains only safe counters/reasons; never retain prompts, raw responses or reasoning text. */
export class StructuredModelOutputError extends Error {
  constructor(readonly code: StructuredOutputErrorCode, readonly diagnostics: StructuredOutputDiagnostics) {
    const stage = labels[diagnostics.role] ?? "当前步骤";
    const reason = code === "MODEL_OUTPUT_LIMIT"
      ? `模型输出达到本步上限${diagnostics.maxOutputTokens > 0 ? `（${diagnostics.maxOutputTokens} tokens）` : "（供应商限制）"}，没有得到完整结果。请检查模型配置的输出上限，或缩小本次任务范围；开启思考时也可关闭思考后重试。`
      : code === "MODEL_OUTPUT_FORMAT" ? "模型返回的数据不符合本步格式要求，请重试这一阶段。"
        : code === "MODEL_OUTPUT_FILTERED" ? "模型服务拦截了本次输出，请调整内容后重试。"
          : "模型未正常结束，未取得完整结果，请稍后重试这一阶段。";
    super(`${stage}：${reason} 本步骤未保存，之前已保存的结果保留。`);
    this.name = "StructuredModelOutputError";
  }
}

type Observation = {
  finishReason?: string;
  text?: string;
  usage?: { outputTokens?: number; outputTokenDetails?: { reasoningTokens?: number } };
  request?: { body?: unknown };
};
interface StructuredResponse extends Observation { readonly output: unknown; }
export async function collectStructuredStream(stream: {
  partialOutputStream: AsyncIterable<unknown>;
  finishReason: PromiseLike<string>;
  totalUsage: PromiseLike<Observation["usage"]>;
  text: PromiseLike<string>;
  request: PromiseLike<Observation["request"]>;
  output: PromiseLike<unknown>;
}, onPartial: (value: unknown) => Promise<void>): Promise<StructuredResponse> {
  for await (const partial of stream.partialOutputStream) await onPartial(partial);
  const [finishReason, usage, text, request] = await Promise.all([stream.finishReason, stream.totalUsage, stream.text, stream.request]);
  let output: unknown, outputError: unknown;
  try { output = await stream.output; } catch (error) { outputError = error; }
  return { finishReason, usage, text, request, get output() { if (outputError) throw outputError; return output; } };
}
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? Math.ceil(value) : undefined;
const reasons = new Set(["stop", "length", "content-filter", "tool-calls", "error", "other", "unknown"]);

/** Observe completion before the SDK parses JSON or exposes its throwing output getter. */
export async function readStructuredModelOutput<T>(
  request: { role: string; maxOutputTokens: number; schema: z.ZodType<T> },
  invoke: (onFinish: (event: Observation) => void) => Promise<StructuredResponse>,
): Promise<{ value: T; outputTokens: number }> {
  let diagnostics: StructuredOutputDiagnostics = { role: request.role, maxOutputTokens: request.maxOutputTokens, finishReason: "unknown", textCharacters: 0 };
  const observe = (event: Observation) => {
    let sentLimit: number | undefined;
    try {
      const body = typeof event.request?.body === "string" ? JSON.parse(event.request.body) : event.request?.body;
      if (body && typeof body === "object") sentLimit = count((body as Record<string, unknown>).max_tokens ?? (body as Record<string, unknown>).max_completion_tokens);
    } catch { /* Only extract a numeric cap; never retain or log request data. */ }
    diagnostics = { ...diagnostics,
      maxOutputTokens: sentLimit && sentLimit > 0 ? sentLimit : diagnostics.maxOutputTokens,
      finishReason: event.finishReason && reasons.has(event.finishReason) ? event.finishReason : "unknown",
      outputTokens: count(event.usage?.outputTokens), reasoningTokens: count(event.usage?.outputTokenDetails?.reasoningTokens),
      textCharacters: typeof event.text === "string" ? event.text.length : 0 };
  };
  try {
    const response = await invoke(observe);
    observe(response);
    if (response.finishReason !== "stop") throw new StructuredModelOutputError(
      response.finishReason === "length" ? "MODEL_OUTPUT_LIMIT" : response.finishReason === "content-filter" ? "MODEL_OUTPUT_FILTERED" : "MODEL_OUTPUT_INCOMPLETE", diagnostics);
    const parsed = request.schema.safeParse(response.output);
    if (!parsed.success) throw new StructuredModelOutputError("MODEL_OUTPUT_FORMAT", diagnostics);
    return { value: parsed.data, outputTokens: diagnostics.outputTokens ?? 0 };
  } catch (error) {
    if (error instanceof StructuredModelOutputError) throw error;
    if (NoObjectGeneratedError.isInstance(error)) {
      if (diagnostics.finishReason === "unknown") observe(error);
      throw new StructuredModelOutputError(diagnostics.finishReason === "length" ? "MODEL_OUTPUT_LIMIT" : "MODEL_OUTPUT_FORMAT", diagnostics);
    }
    if (NoOutputGeneratedError.isInstance(error)) throw new StructuredModelOutputError("MODEL_OUTPUT_INCOMPLETE", diagnostics);
    throw error;
  }
}
