import { createHash } from "node:crypto";

export interface PersistentImageTaskProvider {
  fingerprint: string;
  submit(config: unknown): Promise<{ taskId: string }>;
  query(taskId: string): Promise<{ status: "pending" | "succeeded" | "failed"; outputUrl?: string; error?: string }>;
}

export interface PersistentImageAdapterInput {
  vendorId: string;
  modelName: string;
  endpoint: string;
  model: unknown;
  enabled: boolean;
  persistentImageTaskVersion?: unknown;
  submitImageTask?: unknown;
  queryImageTask?: unknown;
  runtime?: unknown;
  timeoutMs?: number;
}

export class PersistentImageAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistentImageAdapterError";
  }
}

/**
 * Adapt a versioned image vendor into the durable submit/query contract.
 * Submission is deliberately one call: retries belong to the durable job
 * layer, which must never turn an uncertain POST into a second POST.
 */
export function createPersistentImageTaskProvider(input: PersistentImageAdapterInput): PersistentImageTaskProvider {
  if (!input.enabled) throw new PersistentImageAdapterError(`供应商 ${input.vendorId} 未启用，不能提交或恢复持久化图片任务`);
  if (input.persistentImageTaskVersion !== 1) throw new PersistentImageAdapterError(`供应商 ${input.vendorId} 未声明 persistentImageTaskVersion=1`);
  if (typeof input.submitImageTask !== "function" || typeof input.queryImageTask !== "function") {
    throw new PersistentImageAdapterError(`供应商 ${input.vendorId} 未提供 submitImageTask/queryImageTask`);
  }
  const submitFn = input.submitImageTask as (config: unknown, model: unknown) => Promise<unknown>;
  const queryFn = input.queryImageTask as (request: { taskId: string }) => Promise<unknown>;
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new PersistentImageAdapterError("持久化图片任务超时时间不合法");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ vendorId: input.vendorId, endpoint: input.endpoint.replace(/\/+$/, ""), modelName: input.modelName }))
    .digest("hex");
  return {
    fingerprint,
    submit: async (config) => validateSubmit(await withTimeout(() => submitFn.call(input.runtime, config, input.model), timeoutMs)),
    query: async (taskId) => validateQuery(await withTimeout(() => queryFn.call(input.runtime, { taskId }), timeoutMs)),
  };
}

export function withPersistentImageTaskTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  return withTimeout(operation, timeoutMs);
}

function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new PersistentImageAdapterError("持久化图片任务适配器超时")), timeoutMs);
    Promise.resolve().then(operation).then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}

function validateSubmit(value: unknown): { taskId: string } {
  if (!value || typeof value !== "object" || typeof (value as { taskId?: unknown }).taskId !== "string") {
    throw new PersistentImageAdapterError("submitImageTask 未返回 taskId");
  }
  const taskId = (value as { taskId: string }).taskId.trim();
  if (!taskId || taskId.length > 512 || /[\u0000-\u001F\u007F]/.test(taskId)) {
    throw new PersistentImageAdapterError("submitImageTask 返回的 taskId 不合法");
  }
  return { taskId };
}

function validateQuery(value: unknown): { status: "pending" | "succeeded" | "failed"; outputUrl?: string; error?: string } {
  if (!value || typeof value !== "object") throw new PersistentImageAdapterError("queryImageTask 未返回对象");
  const record = value as { status?: unknown; outputUrl?: unknown; error?: unknown };
  if (record.status !== "pending" && record.status !== "succeeded" && record.status !== "failed") {
    throw new PersistentImageAdapterError("queryImageTask 返回了未知状态");
  }
  if (record.status === "succeeded") {
    let parsed: URL | undefined;
    try { if (typeof record.outputUrl === "string") parsed = new URL(record.outputUrl); } catch { /* rejected below */ }
    if (!parsed || !["https:", "http:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      throw new PersistentImageAdapterError("成功的图片任务未返回可用 http(s) 图片地址");
    }
    return { status: "succeeded", outputUrl: record.outputUrl as string };
  }
  if (record.error !== undefined && typeof record.error !== "string") throw new PersistentImageAdapterError("queryImageTask 错误字段不合法");
  return record.error ? { status: record.status, error: record.error } : { status: record.status };
}
