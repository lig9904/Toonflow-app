import { createHash } from "node:crypto";

export interface PersistentVideoTaskProvider {
  fingerprint: string;
  submit(config: unknown): Promise<{ taskId: string }>;
  query(taskId: string): Promise<{ status: "pending" | "succeeded" | "failed"; outputUrl?: string; error?: string }>;
}

export interface PersistentVideoAdapterInput {
  vendorId: string;
  modelName: string;
  endpoint: string;
  model: unknown;
  enabled: boolean;
  persistentVideoTaskVersion?: unknown;
  submitVideoTask?: unknown;
  queryVideoTask?: unknown;
  runtime?: unknown;
  timeoutMs?: number;
}

export class PersistentVideoAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistentVideoAdapterError";
  }
}

/**
 * Turns an explicitly capable vendor runtime into the durable-video contract.
 * Legacy Volcengine templates predate the version flag and remain supported.
 */
export function createPersistentVideoTaskProvider(input: PersistentVideoAdapterInput): PersistentVideoTaskProvider {
  if (!input.enabled) throw new PersistentVideoAdapterError(`供应商 ${input.vendorId} 未启用，不能提交或恢复持久化视频任务`);
  const legacyVolcengine = input.vendorId === "volcengine" && input.persistentVideoTaskVersion == null;
  if (!legacyVolcengine && input.persistentVideoTaskVersion !== 1) {
    throw new PersistentVideoAdapterError(`供应商 ${input.vendorId} 未声明 persistentVideoTaskVersion=1`);
  }
  if (typeof input.submitVideoTask !== "function" || typeof input.queryVideoTask !== "function") {
    throw new PersistentVideoAdapterError(`供应商 ${input.vendorId} 未提供 submitVideoTask/queryVideoTask`);
  }
  const submitFn = input.submitVideoTask as (config: unknown, model: unknown) => Promise<unknown>;
  const queryFn = input.queryVideoTask as (taskId: string) => Promise<unknown>;
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new PersistentVideoAdapterError("持久化视频任务超时时间不合法");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ vendorId: input.vendorId, endpoint: input.endpoint.replace(/\/+$/, ""), modelName: input.modelName }))
    .digest("hex");
  return {
    fingerprint,
    submit: async (config) => validateSubmit(await withTimeout(() => submitFn.call(input.runtime, config, input.model), timeoutMs)),
    query: async (taskId) => validateQuery(await withTimeout(() => queryFn.call(input.runtime, taskId), timeoutMs)),
  };
}

export function withPersistentVideoTaskTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  return withTimeout(operation, timeoutMs);
}

function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new PersistentVideoAdapterError("持久化视频任务适配器超时")), timeoutMs);
    Promise.resolve().then(operation).then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}

function validateSubmit(value: unknown): { taskId: string } {
  if (!value || typeof value !== "object" || typeof (value as { taskId?: unknown }).taskId !== "string") {
    throw new PersistentVideoAdapterError("submitVideoTask 未返回 taskId");
  }
  const taskId = (value as { taskId: string }).taskId.trim();
  if (!taskId || taskId.length > 512 || /[\u0000-\u001F\u007F]/.test(taskId)) {
    throw new PersistentVideoAdapterError("submitVideoTask 返回的 taskId 不合法");
  }
  return { taskId };
}

function validateQuery(value: unknown): { status: "pending" | "succeeded" | "failed"; outputUrl?: string; error?: string } {
  if (!value || typeof value !== "object") throw new PersistentVideoAdapterError("queryVideoTask 未返回对象");
  const record = value as { status?: unknown; outputUrl?: unknown; error?: unknown };
  if (record.status !== "pending" && record.status !== "succeeded" && record.status !== "failed") {
    throw new PersistentVideoAdapterError("queryVideoTask 返回了未知状态");
  }
  if (record.status === "succeeded") {
    let parsed: URL | undefined;
    try { if (typeof record.outputUrl === "string") parsed = new URL(record.outputUrl); } catch { /* reject malformed URLs below */ }
    if (!parsed || !["https:", "http:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      throw new PersistentVideoAdapterError("成功的视频任务未返回可用 http(s) 视频地址");
    }
    return { status: "succeeded", outputUrl: record.outputUrl as string };
  }
  if (record.error !== undefined && typeof record.error !== "string") throw new PersistentVideoAdapterError("queryVideoTask 错误字段不合法");
  return record.error ? { status: record.status, error: record.error } : { status: record.status };
}
