import { APICallError, Output, type generateText } from "ai";
import { z } from "zod";
import { readStructuredModelOutput, StructuredModelOutputError } from "../lib/structuredModelOutput";
import type { VideoPromptReviewModel } from "./videoPromptReview";

export type VideoPromptReviewFailure = {
  code: "MODEL_OUTPUT_LIMIT" | "MODEL_OUTPUT_FORMAT" | "MODEL_OUTPUT_FILTERED" | "MODEL_OUTPUT_INCOMPLETE" | "MODEL_REQUEST_REJECTED" | "MODEL_REQUEST_FAILED" | "MODEL_REQUEST_TIMEOUT" | "MODEL_REQUEST_ABORTED" | "REVIEW_INTERNAL_ERROR";
  finishReason?: string;
  maxOutputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  textCharacters?: number;
  httpStatus?: number;
};
type StructuredResponse = Awaited<ReturnType<Parameters<typeof readStructuredModelOutput>[1]>>;
export type VideoPromptReviewInvoke = (options: Omit<Parameters<typeof generateText>[0], "model" | "prompt" | "messages"> & { prompt: string; messages?: never }) => Promise<StructuredResponse>;

/** The prompt schema is required even when an OpenAI-compatible provider only supports JSON mode. */
export async function invokeVideoPromptReview(request: Parameters<VideoPromptReviewModel>[0], invoke: VideoPromptReviewInvoke, maxOutputTokens?: number): Promise<unknown> {
  const result = await readStructuredModelOutput({ role: "universalAi", maxOutputTokens: maxOutputTokens ?? 0, schema: request.schema }, (onFinish) => invoke({
    system: `${request.system}\n\n当前输出协议优先：仅返回一个完整且紧凑的 JSON 对象，严格遵循下列 schema。不输出 Markdown、代码块、解释或工具调用；不重复输入全文。没有发现时 findings 返回空数组，无需修正时省略 correctedPrompt。\nOUTPUT_JSON_SCHEMA\n${JSON.stringify(z.toJSONSchema(request.schema))}`,
    prompt: JSON.stringify(request.input),
    output: Output.object({ schema: request.schema }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    maxRetries: 0,
    onFinish,
  }));
  return result.value;
}

/** Persist only allowlisted categories and counters, never provider messages, raw output or request bodies. */
export function classifyVideoPromptReviewFailure(error: unknown): VideoPromptReviewFailure {
  if (error instanceof StructuredModelOutputError) {
    const diagnostics = error.diagnostics;
    const result: VideoPromptReviewFailure = { code: error.code };
    if (["stop", "length", "content-filter", "tool-calls", "error", "other", "unknown"].includes(diagnostics.finishReason)) result.finishReason = diagnostics.finishReason;
    for (const key of ["maxOutputTokens", "outputTokens", "reasoningTokens", "textCharacters"] as const) {
      const value = diagnostics[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000) result[key] = Math.ceil(value);
    }
    return result;
  }
  if (error instanceof z.ZodError) return { code: "MODEL_OUTPUT_FORMAT" };
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    const httpStatus = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
    return { code: httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 ? "MODEL_REQUEST_REJECTED" : "MODEL_REQUEST_FAILED", ...(httpStatus === undefined ? {} : { httpStatus }) };
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return { code: "MODEL_REQUEST_TIMEOUT" };
  if (name === "AbortError") return { code: "MODEL_REQUEST_ABORTED" };
  return { code: "REVIEW_INTERNAL_ERROR" };
}
