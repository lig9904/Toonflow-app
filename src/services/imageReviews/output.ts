import type { z } from "zod";

export interface ImageReviewDiagnostics {
  code: string;
  phase: "model_request" | "model_output" | "media" | "worker";
  errorName?: string;
  httpStatus?: number;
  providerCode?: string;
  finishReason?: string;
  textCharacters?: number;
  maxOutputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  expectedImageCount?: number;
  sentImageCount?: number;
  unsupportedImageParts?: number;
  fields?: Array<{ path: string; code: string }>;
}

/** Diagnostics deliberately exclude exception messages, request/response bodies, URLs and headers. */
export class ImageReviewDiagnosticError extends Error {
  constructor(public readonly diagnostics: ImageReviewDiagnostics) {
    super(diagnostics.code);
    this.name = "ImageReviewDiagnosticError";
  }
}

export interface ImageReviewModelResponse {
  kind: "image-review-model-response";
  text: string;
  finishReason: string;
  maxOutputTokens?: number;
  usage?: { outputTokens?: number; outputTokenDetails?: { reasoningTokens?: number } };
  expectedImageCount?: number;
  sentImageCount?: number;
  unsupportedImageParts?: number;
}

const finishReasons = new Set(["stop", "length", "content-filter", "tool-calls", "error", "other", "unknown"]);
const errorNames = new Set(["Error", "AbortError", "TimeoutError", "SyntaxError", "ZodError", "AI_APICallError", "APICallError", "AI_DownloadError", "DownloadError", "AI_NoOutputGeneratedError", "AI_NoObjectGeneratedError", "AI_JSONParseError", "AI_TypeValidationError", "AI_RetryError", "TypeValidationError", "JSONParseError"]);
const providerCodes = new Set(["invalid_parameter", "invalid_parameters", "invalid_request_error", "invalid_request", "bad_request", "unsupported_parameter", "unsupported_value", "context_length_exceeded", "insufficient_quota", "rate_limit_exceeded", "authentication_error", "invalid_api_key", "permission_denied", "server_error", "service_unavailable", "content_filter", "invalid_image", "invalid_image_format", "image_too_large"]);
const fieldNames = new Set(["summary", "findings", "code", "severity", "message", "referenceLabel", "confidence"]);
const zodCodes = new Set(["invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys", "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom"]);
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 10_000_000 ? Math.ceil(value) : undefined;

export function diagnoseImageReviewFailure(error: unknown, phase: ImageReviewDiagnostics["phase"] = "worker"): ImageReviewDiagnostics {
  if (error instanceof ImageReviewDiagnosticError) return error.diagnostics;
  const value = error && typeof error === "object" ? error as Record<string, any> : {};
  const errorName = errorNames.has(value.name) ? value.name as string : "Error";
  const diagnostics: ImageReviewDiagnostics = { code: ["AbortError", "TimeoutError"].includes(errorName) ? "REVIEW_ABORTED" : "REVIEW_FAILED", phase, errorName };
  // SDK errors may wrap an HTTP error. Inspect only bounded, allowlisted fields.
  let current = value;
  for (let depth = 0; depth < 3 && current; depth++) {
    const status = current.statusCode ?? current.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) diagnostics.httpStatus ??= status;
    const codes: unknown[] = [current.code, current.type, current.data?.error?.code, current.data?.error?.type];
    if (typeof current.responseBody === "string" && current.responseBody.length <= 65536) {
      try { const body = JSON.parse(current.responseBody); codes.push(body?.error?.code, body?.error?.type, body?.code); } catch { /* never retain raw text */ }
    }
    const code = codes.find((candidate) => typeof candidate === "string" && providerCodes.has(candidate));
    if (code) diagnostics.providerCode ??= code as string;
    current = current.cause && typeof current.cause === "object" ? current.cause : undefined;
  }
  if (diagnostics.httpStatus) {
    diagnostics.phase = "model_request";
    diagnostics.code = diagnostics.httpStatus === 429 ? "REVIEW_RATE_LIMITED" : [401, 403].includes(diagnostics.httpStatus) ? "REVIEW_AUTH_FAILED" : diagnostics.httpStatus < 500 ? "REVIEW_REQUEST_REJECTED" : "REVIEW_REQUEST_FAILED";
  }
  if (["AI_DownloadError", "DownloadError"].includes(errorName)) { diagnostics.code = "REVIEW_IMAGE_TRANSPORT"; diagnostics.phase = "media"; }
  return diagnostics;
}

/** Accept one complete JSON object with harmless Markdown/prose around it; never repair truncated JSON or manufacture missing fields. */
function parseSingleObject(text: string): unknown {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  try { return JSON.parse(trimmed); } catch { /* Look for one fully balanced object below. */ }
  const start = trimmed.indexOf("{");
  if (start < 0 || trimmed.slice(0, start).includes("[")) throw new Error("invalid JSON envelope");
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      const suffix = trimmed.slice(index + 1);
      if (/[{\[\]}]/.test(suffix)) throw new Error("multiple or wrapped JSON values");
      return JSON.parse(trimmed.slice(start, index + 1));
    }
  }
  throw new Error("incomplete JSON object");
}

export function parseImageReviewOutput<T>(raw: unknown, schema: z.ZodType<T>): { value: T; diagnostics: ImageReviewDiagnostics } {
  const envelope = raw && typeof raw === "object" && (raw as any).kind === "image-review-model-response" ? raw as ImageReviewModelResponse : undefined;
  const text = envelope ? envelope.text : typeof raw === "string" ? raw : undefined;
  const diagnostics: ImageReviewDiagnostics = { code: "REVIEW_OUTPUT_OK", phase: "model_output", ...(typeof text === "string" ? { textCharacters: text.length } : {}) };
  if (envelope) {
    diagnostics.finishReason = finishReasons.has(envelope.finishReason) ? envelope.finishReason : "unknown";
    diagnostics.maxOutputTokens = count(envelope.maxOutputTokens);
    diagnostics.outputTokens = count(envelope.usage?.outputTokens);
    diagnostics.reasoningTokens = count(envelope.usage?.outputTokenDetails?.reasoningTokens);
    diagnostics.expectedImageCount = count(envelope.expectedImageCount);
    diagnostics.sentImageCount = count(envelope.sentImageCount);
    diagnostics.unsupportedImageParts = count(envelope.unsupportedImageParts);
    if ((diagnostics.unsupportedImageParts ?? 0) > 0 || (diagnostics.expectedImageCount != null && diagnostics.sentImageCount != null && diagnostics.sentImageCount < diagnostics.expectedImageCount)) {
      throw new ImageReviewDiagnosticError({ ...diagnostics, code: "REVIEW_VISION_NOT_SENT" });
    }
    if (diagnostics.finishReason !== "stop") {
      diagnostics.code = diagnostics.finishReason === "length" ? "REVIEW_OUTPUT_LIMIT" : diagnostics.finishReason === "content-filter" ? "REVIEW_OUTPUT_FILTERED" : "REVIEW_OUTPUT_INCOMPLETE";
      throw new ImageReviewDiagnosticError(diagnostics);
    }
  }
  let value: unknown = raw;
  if (text != null) {
    try { if (text.length > 200000) throw new Error("oversized output"); value = parseSingleObject(text); }
    catch { throw new ImageReviewDiagnosticError({ ...diagnostics, code: "REVIEW_OUTPUT_JSON", errorName: "SyntaxError" }); }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.slice(0, 8).map((issue) => ({
      path: issue.path.map((part) => typeof part === "number" ? `[${Math.min(part, 999)}]` : fieldNames.has(String(part)) ? String(part) : "unknown").join(".") || "$",
      code: zodCodes.has(issue.code) ? issue.code : "invalid_value",
    }));
    throw new ImageReviewDiagnosticError({ ...diagnostics, code: "REVIEW_OUTPUT_SCHEMA", errorName: "ZodError", fields });
  }
  return { value: parsed.data, diagnostics };
}

export function imageReviewFailureSummary(diagnostics: ImageReviewDiagnostics): string {
  const labels: Record<string, string> = {
    REVIEW_OUTPUT_LIMIT: "视觉模型输出达到上限，结果不完整", REVIEW_OUTPUT_FILTERED: "视觉模型输出被服务商拦截", REVIEW_OUTPUT_INCOMPLETE: "视觉模型未正常结束", REVIEW_OUTPUT_JSON: "视觉模型返回内容不是完整有效的 JSON", REVIEW_OUTPUT_SCHEMA: "视觉模型返回字段不符合核验协议",
    REVIEW_REQUEST_REJECTED: "视觉模型拒绝请求参数", REVIEW_AUTH_FAILED: "视觉模型请求未通过服务商认证或授权", REVIEW_RATE_LIMITED: "视觉模型请求受到服务商限流", REVIEW_REQUEST_FAILED: "视觉模型服务请求失败", REVIEW_TIMEOUT: "视觉核验超时", REVIEW_ABORTED: "视觉核验请求中断", REVIEW_LEASE_LOST: "视觉核验执行租约失效", REVIEW_IMAGE_DECODE: "生成图片无法解码为核验输入", REVIEW_VISION_NOT_SENT: "模型适配器未完整发送实际图片，不能形成视觉结论", REVIEW_IMAGE_TRANSPORT: "图片输入在 SDK 传输准备阶段失败，未形成视觉结论",
  };
  const details = [diagnostics.httpStatus ? `HTTP ${diagnostics.httpStatus}` : "", diagnostics.providerCode ?? "", diagnostics.finishReason ? `finishReason=${diagnostics.finishReason}` : "", diagnostics.fields?.map((field) => `${field.path}:${field.code}`).join("、") ?? ""].filter(Boolean).join("；");
  return `${labels[diagnostics.code] ?? "视觉核验未完成"}${details ? `（${details}）` : ""}；生成图片已保留，未自动重发模型请求`;
}
