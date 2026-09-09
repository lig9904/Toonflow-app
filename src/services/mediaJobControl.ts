import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { lockProjectTransaction } from "../lib/dbTransaction";

const RECEIPTS = "ext_media_job_recoveries";
const RECOVERY_LEASE_MS = 120_000;
const sourceSchema = z.enum(["image", "video"]);
const actionSchema = z.enum(["query", "download"]);
export const mediaJobRecoverySchema = z.object({
  projectId: z.number().int().positive(),
  source: sourceSchema,
  jobId: z.number().int().positive(),
  expectedUpdatedAt: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(150).regex(/^[\w:.-]+$/),
  action: actionSchema,
}).strict();

export type MediaJobSource = z.infer<typeof sourceSchema>;
export type MediaJobRecoveryAction = z.infer<typeof actionSchema>;
export interface MediaJobRecoveryCapability {
  canRecover: boolean;
  expectedUpdatedAt: number;
  recoveryActions: Array<{ action: MediaJobRecoveryAction; label: string }>;
}
export interface MediaJobRecoveryView extends MediaJobRecoveryCapability {
  source: MediaJobSource;
  jobId: number;
  projectId: number;
  status: string;
  updatedAt: number;
  lastError: string | null;
}

interface RecoveryExecutor {
  continueKnown(jobId: number): Promise<{ id: number; projectId: number; status: string; updatedAt: number; lastError: string | null }>;
}

export interface MediaJobRecoveryExecutors { image: RecoveryExecutor; video: RecoveryExecutor; }
let executors: MediaJobRecoveryExecutors | undefined;

export function configureMediaJobRecoveryExecutors(value: MediaJobRecoveryExecutors): void { executors = value; }

export class MediaJobControlError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "PROJECT_MISMATCH" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "NOT_RECOVERABLE" | "RUNTIME_UNAVAILABLE" | "RECOVERY_FAILED",
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "MediaJobControlError";
  }
}

function table(source: MediaJobSource): "ext_image_jobs" | "ext_video_jobs" { return source === "image" ? "ext_image_jobs" : "ext_video_jobs"; }
function actorId(actor: { id?: unknown }): string {
  if (!actor || typeof actor.id !== "string" || !actor.id.trim() || actor.id.length > 250) throw new MediaJobControlError("INVALID_INPUT", "缺少可信操作身份");
  return actor.id;
}
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((name) => `${JSON.stringify(name)}:${stable(record[name])}`).join(",")}}`;
}
const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");

export async function ensureMediaJobControlSchema(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable(RECEIPTS))) {
    await db.schema.createTable(RECEIPTS, (builder) => {
      builder.text("actorId").notNullable();
      builder.bigInteger("projectId").notNullable();
      builder.text("idempotencyKey").notNullable();
      builder.text("requestHash").notNullable();
      builder.text("source").notNullable();
      builder.bigInteger("jobId").notNullable();
      builder.text("action").notNullable();
      builder.text("status").notNullable();
      builder.text("result");
      builder.text("errorCode");
      builder.text("errorMessage");
      builder.bigInteger("createdAt").notNullable();
      builder.bigInteger("updatedAt").notNullable();
      builder.primary(["actorId", "projectId", "idempotencyKey"]);
    });
  } else {
    if (!(await db.schema.hasColumn(RECEIPTS, "source"))) await db.schema.alterTable(RECEIPTS, (builder) => builder.text("source"));
    if (!(await db.schema.hasColumn(RECEIPTS, "jobId"))) await db.schema.alterTable(RECEIPTS, (builder) => builder.bigInteger("jobId"));
    if (!(await db.schema.hasColumn(RECEIPTS, "action"))) await db.schema.alterTable(RECEIPTS, (builder) => builder.text("action"));
  }
}

function capability(row: any): MediaJobRecoveryCapability {
  const actions: MediaJobRecoveryCapability["recoveryActions"] = [];
  if (row?.status === "RECONCILIATION_REQUIRED") {
    if (typeof row.upstreamTaskId === "string" && row.upstreamTaskId.trim()) actions.push({ action: "query", label: "继续查询" });
    if (typeof row.resultUrl === "string" && row.resultUrl.trim()) actions.push({ action: "download", label: "重新保存" });
  }
  return { canRecover: actions.length > 0, expectedUpdatedAt: Number(row?.updatedAt ?? 0), recoveryActions: actions };
}

function view(source: MediaJobSource, row: any): MediaJobRecoveryView {
  return {
    source, jobId: Number(row.id), projectId: Number(row.projectId), status: String(row.status), updatedAt: Number(row.updatedAt),
    lastError: row.lastError == null ? null : String(row.lastError), ...capability(row),
  };
}

async function jobRow(db: Knex | Knex.Transaction, source: MediaJobSource, jobId: number): Promise<any> {
  const columns = ["id", "projectId", "status", "updatedAt", "lastError", "upstreamTaskId", "resultUrl", ...(source === "video" ? ["videoId"] : [])];
  const row = await db(table(source)).where({ id: jobId }).select(columns).first();
  if (!row) throw new MediaJobControlError("NOT_FOUND", "媒体任务不存在", 404);
  return row;
}

export async function mediaJobRecoveryCapability(db: Knex, source: MediaJobSource, jobId: number, projectId?: number): Promise<MediaJobRecoveryView> {
  const parsedSource = sourceSchema.parse(source);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new MediaJobControlError("INVALID_INPUT", "jobId 无效");
  const row = await jobRow(db, parsedSource, jobId);
  if (projectId !== undefined && Number(row.projectId) !== projectId) throw new MediaJobControlError("PROJECT_MISMATCH", "媒体任务不属于当前项目", 403);
  return view(parsedSource, row);
}

export async function recoverMediaJob(db: Knex, raw: unknown, actor: { id: string }): Promise<{ job: MediaJobRecoveryView; reused: boolean; inProgress?: boolean }> {
  const parsed = mediaJobRecoverySchema.safeParse(raw);
  if (!parsed.success) throw new MediaJobControlError("INVALID_INPUT", parsed.error.issues.map((issue) => issue.message).join("; "));
  const input = parsed.data;
  const who = actorId(actor);
  const executor = executors?.[input.source];
  if (!executor) throw new MediaJobControlError("RUNTIME_UNAVAILABLE", "媒体任务恢复运行时尚未接入", 503);
  const requestHash = hash(input);
  const claimed = await db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const old = await trx(RECEIPTS).where({ actorId: who, projectId: input.projectId, idempotencyKey: input.idempotencyKey }).first();
    if (old) {
      if (old.requestHash !== requestHash) throw new MediaJobControlError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同的恢复请求", 409);
      if (old.status === "completed" && old.result) return { replay: JSON.parse(old.result) as MediaJobRecoveryView };
      if (old.status === "failed") throw new MediaJobControlError("RECOVERY_FAILED", String(old.errorMessage ?? "恢复失败"), 409);
      const current = await jobRow(trx, input.source, input.jobId);
      if (Number(current.projectId) !== input.projectId) throw new MediaJobControlError("PROJECT_MISMATCH", "媒体任务不属于当前项目", 403);
      return { replay: view(input.source, current), inProgress: true };
    }
    const current = await jobRow(trx, input.source, input.jobId);
    if (Number(current.projectId) !== input.projectId) throw new MediaJobControlError("PROJECT_MISMATCH", "媒体任务不属于当前项目", 403);
    if (Number(current.updatedAt) !== input.expectedUpdatedAt) throw new MediaJobControlError("VERSION_CONFLICT", "媒体任务状态已变化，请刷新后重试", 409);
    if (current.status !== "RECONCILIATION_REQUIRED") throw new MediaJobControlError("NOT_RECOVERABLE", "媒体任务当前状态不允许人工恢复", 409);
    if (input.action === "query" && !(typeof current.upstreamTaskId === "string" && current.upstreamTaskId.trim())) throw new MediaJobControlError("NOT_RECOVERABLE", "任务没有已知上游任务 ID，不能继续查询", 409);
    if (input.action === "download" && !(typeof current.resultUrl === "string" && current.resultUrl.trim())) throw new MediaJobControlError("NOT_RECOVERABLE", "任务没有已知结果地址，不能重新保存", 409);
    const now = Math.max(Date.now(), Number(current.updatedAt) + 1);
    const nextStatus = input.action === "query" ? (input.source === "video" ? "SUBMITTED" : "POLLING") : "DOWNLOADING";
    const patch = {
      status: nextStatus, nextPollAt: now + RECOVERY_LEASE_MS, updatedAt: now,
      ...(input.action === "query" ? { queryFailures: 0 } : { downloadFailures: 0 }),
    };
    const updated = await trx(table(input.source)).where({ id: input.jobId, projectId: input.projectId, status: "RECONCILIATION_REQUIRED", updatedAt: input.expectedUpdatedAt }).update(patch);
    if (updated !== 1) throw new MediaJobControlError("VERSION_CONFLICT", "媒体任务状态已变化，请刷新后重试", 409);
    if (input.source === "video") await trx("o_video").where({ id: Number(current.videoId), projectId: input.projectId }).update({ state: "生成中" });
    await trx(RECEIPTS).insert({ actorId: who, projectId: input.projectId, idempotencyKey: input.idempotencyKey, requestHash, source: input.source, jobId: input.jobId, action: input.action, status: "started", createdAt: now, updatedAt: now });
    return { execute: true };
  });
  if ("replay" in claimed) return { job: claimed.replay!, reused: true, ...(claimed.inProgress ? { inProgress: true } : {}) };

  try {
    const result = await executor.continueKnown(input.jobId);
    if (Number(result.projectId) !== input.projectId || Number(result.id) !== input.jobId) throw new MediaJobControlError("PROJECT_MISMATCH", "恢复结果不属于当前项目", 403);
    const current = await jobRow(db, input.source, input.jobId);
    const output = view(input.source, current);
    if (output.status === "RECONCILIATION_REQUIRED" && /供应商.*(?:变化|不可恢复)|端点.*变化|模型绑定已变化/.test(output.lastError ?? "")) {
      throw new MediaJobControlError("NOT_RECOVERABLE", output.lastError ?? "供应商绑定已变化，不能查询旧任务", 409);
    }
    await db(RECEIPTS).where({ actorId: who, projectId: input.projectId, idempotencyKey: input.idempotencyKey, status: "started" }).update({ status: "completed", result: JSON.stringify(output), updatedAt: Math.max(Date.now(), output.updatedAt) });
    return { job: output, reused: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db(RECEIPTS).where({ actorId: who, projectId: input.projectId, idempotencyKey: input.idempotencyKey, status: "started" }).update({ status: "failed", errorCode: String((error as any)?.code ?? "RECOVERY_FAILED"), errorMessage: message, updatedAt: Date.now() });
    if (error instanceof MediaJobControlError) throw error;
    throw new MediaJobControlError("RECOVERY_FAILED", message, 409);
  }
}
