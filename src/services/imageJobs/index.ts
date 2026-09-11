import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { PersistentImageTaskProvider, PersistentImageResult, ImageSubmissionOutcome } from "../../lib/persistentImageAdapter";

export type ImageJobStatus = "RESERVED" | "SUBMITTING" | "POLLING" | "DOWNLOADING" | "SUCCEEDED" | "FAILED" | "RECONCILIATION_REQUIRED";

export interface ImageJobPayload {
  projectId: number;
  modelKey: string;
  providerFingerprint: string;
  outputPath: string;
  config: unknown;
  context?: unknown;
  executionMode?: "sync" | "async";
}

export interface ImageJobRequest {
  projectId: number;
  modelKey: string;
  idempotencyKey: string;
  config: unknown;
  outputPath: string;
  context?: unknown;
}

export interface ImageJob {
  id: number;
  idempotencyKey: string;
  payloadHash: string;
  modelKey: string;
  projectId: number;
  outputPath: string;
  payload: ImageJobPayload;
  upstreamTaskId: string | null;
  resultUrl: string | null;
  status: ImageJobStatus;
  pollAttempts: number;
  queryFailures: number;
  downloadFailures: number;
  nextPollAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  executionMode: "sync" | "async";
  submissionOutcome: "submitted" | "not_submitted" | "rejected" | "unknown" | null;
  submissionOwner: string | null;
  submissionLeaseUntil: number | null;
}

export interface ImageJobDependencies {
  providerFor: (modelKey: string) => Promise<PersistentImageTaskProvider>;
  download: (url: string, outputPath: string) => Promise<void>;
  onSaved?: (job: ImageJob, trx: Knex.Transaction) => Promise<void> | void;
  now?: () => number;
  maxConcurrent?: number;
  maxQueryFailures?: number;
  maxDownloadFailures?: number;
  submissionLeaseMs?: number;
  initialPollDelayMs?: number;
  schedule?: boolean;
}

export type ImageJobServiceOptions = ImageJobDependencies & { db: Knex };

export class ImageJobError extends Error {
  constructor(public readonly code: "CONFLICT" | "NOT_FOUND" | "PROJECT_MISMATCH" | "INVALID_INPUT" | "UNSUPPORTED_PROVIDER", message: string) {
    super(message);
    this.name = "ImageJobError";
  }
}

interface JobRow {
  id: number | string;
  idempotencyKey: string;
  payloadHash: string;
  modelKey: string;
  projectId: number | string;
  outputPath: string;
  payload: string;
  upstreamTaskId: string | null;
  resultUrl: string | null;
  status: ImageJobStatus;
  pollAttempts: number | string;
  queryFailures: number | string;
  downloadFailures: number | string;
  nextPollAt: number | string | null;
  lastError: string | null;
  createdAt: number | string;
  updatedAt: number | string;
  executionMode: "sync" | "async" | null;
  submissionOwner: string | null;
  submissionLeaseUntil: number | string | null;
  submissionOutcome: "submitted" | "not_submitted" | "rejected" | "unknown" | null;
}

const TABLE = "ext_image_jobs";
// Keep a small recovery margin beyond the adapter's 300s request deadline so
// another worker cannot reconcile a still-finishing request at the boundary.
const SYNC_SUBMISSION_LEASE_MS = 305_000;

export async function ensureImageJobsSchema(db: Knex): Promise<void> {
  if (isPostgres(db)) {
    await db.raw(`
      CREATE TABLE IF NOT EXISTS "${TABLE}" (
        id bigserial PRIMARY KEY,
        "idempotencyKey" text NOT NULL,
        "payloadHash" text NOT NULL,
        "modelKey" text NOT NULL,
        "projectId" bigint NOT NULL,
        "outputPath" text NOT NULL,
        payload text NOT NULL,
        "upstreamTaskId" text,
        "resultUrl" text,
        status text NOT NULL,
        "pollAttempts" bigint NOT NULL DEFAULT 0,
        "queryFailures" bigint NOT NULL DEFAULT 0,
        "downloadFailures" bigint NOT NULL DEFAULT 0,
        "nextPollAt" bigint,
        "lastError" text,
        "createdAt" bigint NOT NULL,
        "updatedAt" bigint NOT NULL,
        "executionMode" text NOT NULL DEFAULT 'async',
        "submissionOwner" text,
        "submissionLeaseUntil" bigint,
        "submissionOutcome" text,
        UNIQUE ("projectId", "idempotencyKey")
      )
    `);
    await db.raw(`CREATE INDEX IF NOT EXISTS "ext_image_jobs_status_poll_idx" ON "${TABLE}" (status, "nextPollAt")`);
    await db.raw(`CREATE INDEX IF NOT EXISTS "ext_image_jobs_project_idx" ON "${TABLE}" ("projectId", "createdAt")`);
    await db.raw(`ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "executionMode" text NOT NULL DEFAULT 'async'`);
    await db.raw(`ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "submissionOwner" text`);
    await db.raw(`ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "submissionLeaseUntil" bigint`);
    await db.raw(`ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "submissionOutcome" text`);
    return;
  }
  if (!(await db.schema.hasTable(TABLE))) {
    await db.schema.createTable(TABLE, (table) => {
      table.increments("id").primary();
      table.text("idempotencyKey").notNullable();
      table.text("payloadHash").notNullable();
      table.text("modelKey").notNullable();
      table.integer("projectId").notNullable();
      table.text("outputPath").notNullable();
      table.text("payload").notNullable();
      table.text("upstreamTaskId");
      table.text("resultUrl");
      table.text("status").notNullable();
      table.integer("pollAttempts").notNullable().defaultTo(0);
      table.integer("queryFailures").notNullable().defaultTo(0);
      table.integer("downloadFailures").notNullable().defaultTo(0);
      table.integer("nextPollAt");
      table.text("lastError");
      table.integer("createdAt").notNullable();
      table.integer("updatedAt").notNullable();
      table.text("executionMode").notNullable().defaultTo("async");
      table.text("submissionOwner");
      table.integer("submissionLeaseUntil");
      table.text("submissionOutcome");
      table.index(["status", "nextPollAt"]);
      table.index(["projectId", "createdAt"]);
      table.unique(["projectId", "idempotencyKey"]);
    });
  } else {
    if (!(await db.schema.hasColumn(TABLE, "executionMode"))) await db.schema.alterTable(TABLE, (table) => table.text("executionMode").notNullable().defaultTo("async"));
    if (!(await db.schema.hasColumn(TABLE, "submissionOwner"))) await db.schema.alterTable(TABLE, (table) => table.text("submissionOwner"));
    if (!(await db.schema.hasColumn(TABLE, "submissionLeaseUntil"))) await db.schema.alterTable(TABLE, (table) => table.integer("submissionLeaseUntil"));
    if (!(await db.schema.hasColumn(TABLE, "submissionOutcome"))) await db.schema.alterTable(TABLE, (table) => table.text("submissionOutcome"));
  }
}

function isPostgres(db: Knex | Knex.Transaction): boolean {
  return String((db.client as any)?.config?.client).toLowerCase() === "pg";
}

async function insertId(trx: Knex.Transaction, row: Record<string, unknown>): Promise<number | null> {
  if (isPostgres(trx)) {
    const [value] = await trx(TABLE).insert(row).onConflict(["projectId", "idempotencyKey"]).ignore().returning("id");
    if (!value) return null;
    return Number(typeof value === "object" ? (value as { id: number }).id : value);
  }
  const [value] = await trx(TABLE).insert(row).onConflict(["projectId", "idempotencyKey"]).ignore();
  if (value === undefined) return null;
  return Number(value);
}

export class ImageJobService {
  private readonly db: Knex;
  private readonly dependencies: ImageJobDependencies;
  private readonly now: () => number;
  private readonly maxConcurrent: number;
  private readonly maxQueryFailures: number;
  private readonly maxDownloadFailures: number;
  private readonly initialPollDelayMs: number;
  private readonly submissionLeaseMs: number;
  private readonly workerId: string;
  private readonly scheduleEnabled: boolean;
  private readonly active = new Map<number, Promise<ImageJob>>();
  private readonly localSubmitting = new Set<number>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private running = 0;
  private stopped = false;
  private readonly waiters: Array<() => void> = [];

  constructor(db: Knex, dependencies: ImageJobDependencies);
  constructor(options: ImageJobServiceOptions);
  constructor(dbOrOptions: Knex | ImageJobServiceOptions, dependencies?: ImageJobDependencies) {
    if (dependencies) {
      this.db = dbOrOptions as Knex;
      this.dependencies = dependencies;
    } else {
      const options = dbOrOptions as ImageJobServiceOptions;
      this.db = options.db;
      const { db: _db, ...rest } = options;
      this.dependencies = rest;
    }
    this.now = this.dependencies.now ?? Date.now;
    this.maxConcurrent = this.dependencies.maxConcurrent ?? 2;
    this.maxQueryFailures = this.dependencies.maxQueryFailures ?? 5;
    this.maxDownloadFailures = this.dependencies.maxDownloadFailures ?? 5;
    this.initialPollDelayMs = this.dependencies.initialPollDelayMs ?? 5_000;
    this.submissionLeaseMs = this.dependencies.submissionLeaseMs ?? 60_000;
    this.workerId = randomUUID();
    this.scheduleEnabled = this.dependencies.schedule ?? true;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 20) throw new ImageJobError("INVALID_INPUT", "maxConcurrent 必须在 1 到 20 之间");
  }

  async reserve(input: ImageJobRequest): Promise<{ job: ImageJob; reused: boolean }>;
  async reserve(idempotencyKey: string, input: Omit<ImageJobRequest, "idempotencyKey">): Promise<{ job: ImageJob; reused: boolean }>;
  async reserve(inputOrKey: ImageJobRequest | string, request?: Omit<ImageJobRequest, "idempotencyKey">): Promise<{ job: ImageJob; reused: boolean }> {
    const input: ImageJobRequest = typeof inputOrKey === "string" ? { ...request!, idempotencyKey: inputOrKey } : inputOrKey;
    this.assertRequest(input);
    const provider = await this.provider(input.modelKey);
    const executionMode = provider.executionMode === "sync" ? "sync" : "async";
    // Keep legacy async payload bytes/hash unchanged. The mode marker is only
    // persisted for sync providers, where it is required to avoid a fake
    // task-id/query lifecycle.
    const basePayload: ImageJobPayload = { projectId: input.projectId, modelKey: input.modelKey, providerFingerprint: provider.fingerprint, outputPath: input.outputPath, config: input.config, context: input.context };
    const payload: ImageJobPayload = executionMode === "sync" ? { ...basePayload, executionMode: "sync" } : basePayload;
    const payloadHash = hashImageJobRequest(payload);
    return this.db.transaction(async (trx) => {
      const existing = await trx<JobRow>(TABLE).where({ projectId: input.projectId, idempotencyKey: input.idempotencyKey }).first();
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new ImageJobError("CONFLICT", "idempotencyKey 已用于不同的图片任务参数");
        return { job: this.toJob(existing), reused: true };
      }
      const now = this.now();
      let id: number | null;
      id = await insertId(trx, { idempotencyKey: input.idempotencyKey, payloadHash, modelKey: input.modelKey, projectId: input.projectId, outputPath: input.outputPath, payload: JSON.stringify(payload), status: "RESERVED", executionMode, submissionOwner: null, submissionLeaseUntil: null, submissionOutcome: null, createdAt: now, updatedAt: now });
      if (id === null) {
        const raced = await trx<JobRow>(TABLE).where({ projectId: input.projectId, idempotencyKey: input.idempotencyKey }).first();
        if (!raced) throw new ImageJobError("CONFLICT", "幂等图片任务在创建时消失");
        if (raced.payloadHash !== payloadHash) throw new ImageJobError("CONFLICT", "idempotencyKey 已用于不同的图片任务参数");
        return { job: this.toJob(raced), reused: true };
      }
      const row = await trx<JobRow>(TABLE).where({ id }).first();
      if (!row) throw new ImageJobError("NOT_FOUND", "图片任务保留失败");
      return { job: this.toJob(row), reused: false };
    });
  }

  create(input: ImageJobRequest): Promise<{ job: ImageJob; reused: boolean }> { return this.reserve(input); }

  async submitReserved(jobId: number): Promise<ImageJob> { return this.runExclusive(jobId, () => this.runJob(jobId, true)); }
  async runReserved(jobId: number): Promise<ImageJob> { return this.submitReserved(jobId); }
  async submit(jobId: number): Promise<ImageJob> { return this.submitReserved(jobId); }

  /** Manual recovery continuation. This path can only query/download an existing receipt and never submits. */
  async continueKnown(jobId: number): Promise<ImageJob> {
    this.assertPositiveInteger(jobId, "jobId");
    return this.runExclusive(jobId, () => this.runJob(jobId, false));
  }

  async resumeDueJobs(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    await this.db.transaction(async (trx) => {
      const stranded = await trx<JobRow>(TABLE).where({ status: "SUBMITTING" }).whereNull("upstreamTaskId");
      for (const row of stranded) {
        if (this.localSubmitting.has(Number(row.id))) continue;
        const leaseUntil = row.submissionLeaseUntil == null
          ? Number(row.updatedAt) + (row.executionMode === "sync" ? SYNC_SUBMISSION_LEASE_MS : this.submissionLeaseMs)
          : Number(row.submissionLeaseUntil);
        if (leaseUntil > now) continue;
        await this.markReconciliation(trx, row, row.executionMode === "sync" ? "同步图片请求租约已到期，结果未知，禁止重复提交" : "提交前进程中断，未记录上游任务 ID", { status: "SUBMITTING", owner: row.submissionOwner, submissionLeaseUntil: row.submissionLeaseUntil == null ? null : Number(row.submissionLeaseUntil), upstreamTaskId: row.upstreamTaskId });
      }
    });
    const rows = await this.db<JobRow>(TABLE).whereIn("status", ["POLLING", "DOWNLOADING"]);
    const due = rows.filter((row) => row.nextPollAt == null || Number(row.nextPollAt) <= now);
    for (const row of rows.filter((item) => item.nextPollAt != null && Number(item.nextPollAt) > now)) this.schedule(Number(row.id), Number(row.nextPollAt));
    await Promise.all(due.map((row) => this.runExclusive(Number(row.id), () => this.runJob(Number(row.id), false))));
  }

  recover(): Promise<void> { return this.resumeDueJobs(); }
  resume(): Promise<void> { return this.resumeDueJobs(); }

  async get(jobId: number): Promise<ImageJob> {
    this.assertPositiveInteger(jobId, "jobId");
    const row = await this.db<JobRow>(TABLE).where({ id: jobId }).first();
    if (!row) throw new ImageJobError("NOT_FOUND", "图片任务不存在");
    return this.toJob(row);
  }

  async list(projectId: number, limit?: number): Promise<ImageJob[]>;
  async list(input: { projectId: number; limit?: number }): Promise<ImageJob[]>;
  async list(projectOrInput: number | { projectId: number; limit?: number }, limit = 100): Promise<ImageJob[]> {
    const projectId = typeof projectOrInput === "number" ? projectOrInput : projectOrInput.projectId;
    if (typeof projectOrInput !== "number" && projectOrInput.limit !== undefined) limit = projectOrInput.limit;
    this.assertPositiveInteger(projectId, "projectId");
    const rows = await this.db<JobRow>(TABLE).where({ projectId }).orderBy("createdAt", "desc").limit(Math.min(200, Math.max(1, Math.floor(limit))));
    return rows.map((row) => this.toJob(row));
  }

  async findByIdempotency(projectId: number, idempotencyKey: string): Promise<ImageJob | undefined> {
    this.assertPositiveInteger(projectId, "projectId"); this.assertIdempotencyKey(idempotencyKey);
    const row = await this.db<JobRow>(TABLE).where({ projectId, idempotencyKey }).first();
    return row ? this.toJob(row) : undefined;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async runJob(jobId: number, maySubmit: boolean): Promise<ImageJob> {
    let job = await this.get(jobId);
    if (["SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED"].includes(job.status)) return job;
    if (!job.upstreamTaskId) {
      // A sync provider has no upstream task ID by design. Once its result is
      // durably stored, restart/retry must continue the download only.
      if ((job.executionMode === "sync" || job.payload.executionMode === "sync") && job.status === "DOWNLOADING" && job.resultUrl) return this.download(job, job.resultUrl);
      if (job.status === "SUBMITTING") {
        const leaseUntil = job.submissionLeaseUntil ?? job.updatedAt + (job.executionMode === "sync" ? SYNC_SUBMISSION_LEASE_MS : this.submissionLeaseMs);
        if (leaseUntil > this.now()) return job;
        await this.db.transaction((trx) => this.markReconciliation(trx, rowFromJob(job), job.executionMode === "sync" ? "同步图片请求租约已到期，结果未知，禁止重复提交" : "提交前进程中断，未记录上游任务 ID", { status: "SUBMITTING", owner: job.submissionOwner, submissionLeaseUntil: job.submissionLeaseUntil, upstreamTaskId: job.upstreamTaskId }));
        return this.get(jobId);
      }
      if (!maySubmit || job.status !== "RESERVED") {
        await this.db.transaction((trx) => this.markReconciliation(trx, rowFromJob(job), "没有可恢复的上游图片任务 ID"));
        return this.get(jobId);
      }
      const executionMode = job.executionMode === "sync" || job.payload.executionMode === "sync" ? "sync" : "async";
      const now = this.now();
      const claimed = await this.db(TABLE).where({ id: job.id, status: "RESERVED" }).update({ status: "SUBMITTING", executionMode, submissionOwner: this.workerId, submissionLeaseUntil: now + (executionMode === "sync" ? SYNC_SUBMISSION_LEASE_MS : this.submissionLeaseMs), updatedAt: now, lastError: null });
      if (claimed !== 1) return this.get(jobId);
      job = await this.get(job.id);
      this.localSubmitting.add(job.id);
      try {
        const provider = await this.provider(job.modelKey);
        if (provider.fingerprint !== job.payload.providerFingerprint) {
          await this.db.transaction((trx) => this.markReconciliation(trx, rowFromJob(job), "当前供应商端点或模型绑定已变化，不能提交旧保留任务", { status: "SUBMITTING", owner: this.workerId, submissionLeaseUntil: job.submissionLeaseUntil, upstreamTaskId: job.upstreamTaskId, onlyWithoutUpstream: true }));
          return this.get(jobId);
        }
        const submitted = await provider.submit(job.payload.config);
        if (provider.executionMode === "sync") {
          const result = normalizeSyncResult(submitted);
          const resultUrl = result.outputUrl ?? `data:${result.mimeType};base64,${result.outputBase64}`;
          const changed = await this.db(TABLE).where({ id: job.id, status: "SUBMITTING", submissionOwner: this.workerId }).whereNull("upstreamTaskId").update({ status: "DOWNLOADING", resultUrl, executionMode: "sync", submissionOutcome: "submitted", submissionLeaseUntil: null, submissionOwner: null, payload: JSON.stringify(compactImagePayload(job.payload)), nextPollAt: this.now(), updatedAt: this.now(), lastError: null });
          if (changed !== 1) throw new ImageJobError("CONFLICT", "同步图片结果无法安全写入当前任务状态");
        } else {
          const asyncResult = submitted as { taskId?: unknown };
          if (typeof asyncResult?.taskId !== "string" || !asyncResult.taskId.trim()) throw new Error("上游未返回任务 ID");
          const changed = await this.db(TABLE).where({ id: job.id, status: "SUBMITTING", submissionOwner: this.workerId }).whereNull("upstreamTaskId").update({ upstreamTaskId: asyncResult.taskId.trim(), status: "POLLING", executionMode: "async", submissionOutcome: "submitted", submissionLeaseUntil: null, submissionOwner: null, payload: JSON.stringify(compactImagePayload(job.payload)), nextPollAt: this.now(), updatedAt: this.now(), lastError: null });
          if (changed !== 1) throw new ImageJobError("CONFLICT", "图片结果无法安全写入当前任务状态");
        }
      } catch (error) {
        const outcome = submissionOutcome(error);
        if (outcome === "not_submitted" || outcome === "rejected") await this.failUnsubmitted(job, `${outcome === "rejected" ? "上游拒绝图片任务" : "图片任务未提交到上游"}：${errorMessage(error)}`, outcome);
        else await this.db.transaction(async (trx) => {
          const current = await trx<JobRow>(TABLE).where({ id: job.id }).forUpdate().first();
          if (current?.status === "SUBMITTING" && current.submissionOwner === this.workerId && !current.upstreamTaskId) await this.markReconciliation(trx, current, `提交结果不确定：${errorMessage(error)}`, { status: "SUBMITTING", owner: this.workerId, submissionLeaseUntil: current.submissionLeaseUntil == null ? null : Number(current.submissionLeaseUntil), upstreamTaskId: current.upstreamTaskId, onlyWithoutUpstream: true });
        });
        return this.get(jobId);
      } finally {
        this.localSubmitting.delete(job.id);
      }
      job = await this.get(jobId);
    }
    return this.pollOrDownload(job);
  }

  private async pollOrDownload(job: ImageJob): Promise<ImageJob> {
    if (job.status === "DOWNLOADING" && job.resultUrl) return this.download(job, job.resultUrl);
    let provider: PersistentImageTaskProvider;
    try { provider = await this.provider(job.modelKey); }
    catch (error) { await this.db.transaction((trx) => this.markReconciliation(trx, rowFromJob(job), `供应商不可恢复：${errorMessage(error)}`)); return this.get(job.id); }
    if (provider.fingerprint !== job.payload.providerFingerprint) {
      await this.db.transaction((trx) => this.markReconciliation(trx, rowFromJob(job), "当前供应商端点或模型绑定已变化，不能查询旧任务"));
      return this.get(job.id);
    }
    let result: Awaited<ReturnType<PersistentImageTaskProvider["query"]>>;
    try { result = await provider.query(job.upstreamTaskId!); }
    catch (error) { return this.deferQuery(job, errorMessage(error)); }
    if (result.status === "pending") return this.deferPoll(job);
    if (result.status === "failed") return this.fail(job, result.error ?? "上游图片任务失败");
    if (!result.outputUrl) return this.deferQuery(job, "上游任务成功但未返回图片地址");
    await this.db(TABLE).where({ id: job.id }).update({ status: "DOWNLOADING", resultUrl: result.outputUrl, nextPollAt: this.now(), updatedAt: this.now(), lastError: null });
    return this.download(await this.get(job.id), result.outputUrl);
  }

  private async download(job: ImageJob, url: string): Promise<ImageJob> {
    try {
      await this.dependencies.download(url, job.outputPath);
      await this.db.transaction(async (trx) => {
        const completed: ImageJob = { ...job, status: "SUCCEEDED", resultUrl: url, updatedAt: this.now(), lastError: null, nextPollAt: null };
        if (this.dependencies.onSaved) await this.dependencies.onSaved(completed, trx);
        await trx(TABLE).where({ id: job.id, status: "DOWNLOADING" }).update({ status: "SUCCEEDED", resultUrl: isInlineImageData(url) ? null : url, payload: JSON.stringify(compactImagePayload(job.payload)), nextPollAt: null, updatedAt: this.now(), lastError: null });
      });
    } catch (error) {
      if (this.dependencies.onSaved && isPermanentSaveConflict(error)) {
        await this.db.transaction((trx) => this.markReconciliation(trx, rowFromJob(job), `保存图片结果被拒绝：${errorMessage(error)}`));
        return this.get(job.id);
      }
      const failures = job.downloadFailures + 1;
      const message = `下载图片失败：${errorMessage(error)}`;
      if (failures >= this.maxDownloadFailures) {
        await this.db.transaction((trx) => this.markReconciliation(trx, rowFromJob(job), `下载图片连续失败：${message}`));
        return this.get(job.id);
      }
      const nextPollAt = this.now() + this.backoff(failures);
      await this.db(TABLE).where({ id: job.id }).update({ status: "DOWNLOADING", downloadFailures: failures, nextPollAt, lastError: message, updatedAt: this.now() });
      this.schedule(job.id, nextPollAt);
    }
    return this.get(job.id);
  }

  private async deferPoll(job: ImageJob): Promise<ImageJob> {
    const attempts = job.pollAttempts + 1;
    const nextPollAt = this.now() + this.backoff(attempts);
    await this.db(TABLE).where({ id: job.id }).update({ status: "POLLING", pollAttempts: attempts, nextPollAt, updatedAt: this.now(), lastError: null });
    this.schedule(job.id, nextPollAt);
    return this.get(job.id);
  }

  private async deferQuery(job: ImageJob, message: string): Promise<ImageJob> {
    const failures = job.queryFailures + 1;
    if (failures >= this.maxQueryFailures) {
      await this.db.transaction((trx) => this.markReconciliation(trx, rowFromJob(job), `查询图片任务连续失败：${message}`));
      return this.get(job.id);
    }
    const nextPollAt = this.now() + this.backoff(failures);
    await this.db(TABLE).where({ id: job.id }).update({ status: "POLLING", queryFailures: failures, nextPollAt, updatedAt: this.now(), lastError: `查询图片任务失败：${message}` });
    this.schedule(job.id, nextPollAt);
    return this.get(job.id);
  }

  private async failUnsubmitted(job: ImageJob, message: string, outcome: ImageSubmissionOutcome): Promise<ImageJob> {
    await this.db.transaction(async (trx) => {
      let query = trx(TABLE).where({ id: job.id, status: "SUBMITTING", submissionOwner: this.workerId }).whereNull("upstreamTaskId");
      query = job.submissionLeaseUntil == null ? query.whereNull("submissionLeaseUntil") : query.where({ submissionLeaseUntil: job.submissionLeaseUntil });
      await query.update({ status: "FAILED", submissionOutcome: outcome, submissionLeaseUntil: null, submissionOwner: null, payload: JSON.stringify(compactImagePayload(job.payload)), nextPollAt: null, lastError: message, updatedAt: this.now() });
    });
    return this.get(job.id);
  }

  private async fail(job: ImageJob, message: string): Promise<ImageJob> {
    await this.db.transaction((trx) => trx(TABLE).where({ id: job.id }).update({ status: "FAILED", payload: JSON.stringify(compactImagePayload(job.payload)), nextPollAt: null, lastError: message, updatedAt: this.now() }));
    return this.get(job.id);
  }

  private async markReconciliation(trx: Knex.Transaction, row: JobRow, message: string, guard: { status?: ImageJobStatus; owner?: string | null; submissionLeaseUntil?: number | null; upstreamTaskId?: string | null; onlyWithoutUpstream?: boolean } = {}): Promise<void> {
    let query = trx(TABLE).where({ id: row.id });
    query = query.where({ status: guard.status ?? row.status });
    if (guard.owner === null) query = query.whereNull("submissionOwner");
    else if (guard.owner !== undefined) query = query.where({ submissionOwner: guard.owner });
    if (guard.onlyWithoutUpstream || !row.upstreamTaskId) query = query.whereNull("upstreamTaskId");
    if (guard.submissionLeaseUntil === null) query = query.whereNull("submissionLeaseUntil");
    else if (guard.submissionLeaseUntil !== undefined) query = query.where({ submissionLeaseUntil: guard.submissionLeaseUntil });
    if (guard.upstreamTaskId === null) query = query.whereNull("upstreamTaskId");
    else if (guard.upstreamTaskId !== undefined) query = query.where({ upstreamTaskId: guard.upstreamTaskId });
    const hasAcceptedResult = Boolean(row.upstreamTaskId || row.resultUrl || row.submissionOutcome === "submitted");
    await query.update({ status: "RECONCILIATION_REQUIRED", submissionOutcome: hasAcceptedResult ? "submitted" : "unknown", submissionLeaseUntil: null, submissionOwner: null, payload: compactPayloadText(row.payload), nextPollAt: null, lastError: message, updatedAt: this.now() });
  }

  private async provider(modelKey: string): Promise<PersistentImageTaskProvider> {
    try {
      const provider = await this.dependencies.providerFor(modelKey);
      if (!provider || typeof provider.fingerprint !== "string" || !provider.fingerprint.trim() || typeof provider.submit !== "function" || (provider.executionMode !== "sync" && typeof provider.query !== "function")) throw new Error("图片 provider 契约不完整");
      return provider;
    } catch (error) {
      if (error instanceof ImageJobError) throw error;
      throw new ImageJobError("UNSUPPORTED_PROVIDER", errorMessage(error));
    }
  }

  private runExclusive(jobId: number, work: () => Promise<ImageJob>): Promise<ImageJob> {
    const existing = this.active.get(jobId);
    if (existing) return existing;
    if (this.stopped) return this.get(jobId);
    const promise = this.withPermit(work).finally(() => this.active.delete(jobId));
    this.active.set(jobId, promise);
    return promise;
  }

  private async withPermit<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.running += 1;
    try { return await work(); } finally { this.running -= 1; this.waiters.shift()?.(); }
  }

  private schedule(jobId: number, dueAt: number): void {
    if (this.stopped || !this.scheduleEnabled) return;
    const existing = this.timers.get(jobId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { this.timers.delete(jobId); void this.runExclusive(jobId, () => this.runJob(jobId, false)); }, Math.max(0, dueAt - this.now()));
    this.timers.set(jobId, timer);
  }

  private backoff(attempt: number): number { return Math.min(60_000, this.initialPollDelayMs * 2 ** Math.min(attempt - 1, 6)); }

  private toJob(row: JobRow): ImageJob {
    let payload: ImageJobPayload;
    try { payload = JSON.parse(row.payload) as ImageJobPayload; } catch { throw new ImageJobError("INVALID_INPUT", "持久化图片任务内容损坏"); }
    return { ...row, id: Number(row.id), projectId: Number(row.projectId), pollAttempts: Number(row.pollAttempts), queryFailures: Number(row.queryFailures), downloadFailures: Number(row.downloadFailures), nextPollAt: row.nextPollAt == null ? null : Number(row.nextPollAt), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt), executionMode: row.executionMode === "sync" || payload.executionMode === "sync" ? "sync" : "async", submissionOutcome: row.submissionOutcome ?? null, submissionOwner: row.submissionOwner ?? null, submissionLeaseUntil: row.submissionLeaseUntil == null ? null : Number(row.submissionLeaseUntil), payload };
  }

  private assertRequest(input: ImageJobRequest): void {
    if (!input || typeof input !== "object" || typeof input.modelKey !== "string" || !input.modelKey.trim() || typeof input.outputPath !== "string" || !input.outputPath) throw new ImageJobError("INVALID_INPUT", "图片任务参数不完整");
    this.assertPositiveInteger(input.projectId, "projectId"); this.assertIdempotencyKey(input.idempotencyKey);
    try { JSON.stringify(input.config); JSON.stringify(input.context ?? null); } catch { throw new ImageJobError("INVALID_INPUT", "图片任务配置不可序列化"); }
  }

  private assertIdempotencyKey(value: string): void { if (typeof value !== "string" || value.length < 8 || value.length > 200) throw new ImageJobError("INVALID_INPUT", "idempotencyKey 不合法"); }
  private assertPositiveInteger(value: unknown, name: string): void { if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new ImageJobError("INVALID_INPUT", `${name} 必须是正安全整数`); }
}

export function hashImageJobRequest(payload: ImageJobPayload): string { return createHash("sha256").update(stableJson(payload)).digest("hex"); }

function compactImagePayload(payload: ImageJobPayload): ImageJobPayload {
  const config = payload.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return payload;
  const record = config as Record<string, unknown>;
  if (!Array.isArray(record.referenceList)) return payload;
  const referenceList = record.referenceList.map((reference) => {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) return reference;
    const source = reference as Record<string, unknown>;
    const { base64, ...rest } = source;
    if (typeof base64 !== "string") return rest;
    return { ...rest, contentHash: createHash("sha256").update(base64).digest("hex") };
  });
  return { ...payload, config: { ...record, referenceList } };
}

function compactPayloadText(payloadText: string): string { try { return JSON.stringify(compactImagePayload(JSON.parse(payloadText) as ImageJobPayload)); } catch { return payloadText; } }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function submissionOutcome(error: unknown): ImageSubmissionOutcome | undefined {
  const value = error && typeof error === "object" ? (error as { submissionOutcome?: unknown }).submissionOutcome : undefined;
  return value === "not_submitted" || value === "rejected" ? value : undefined;
}
function normalizeSyncResult(value: unknown): PersistentImageResult {
  if (!value || typeof value !== "object") throw new ImageJobError("INVALID_INPUT", "同步图片请求未返回结果");
  const result = value as PersistentImageResult;
  const hasUrl = typeof result.outputUrl === "string" && result.outputUrl.trim().length > 0;
  const hasBase64 = typeof result.outputBase64 === "string" && result.outputBase64.length > 0 && (result.mimeType === "image/png" || result.mimeType === "image/jpeg");
  if (hasUrl === hasBase64) throw new ImageJobError("INVALID_INPUT", "同步图片请求必须返回合法的 URL 或 base64 结果");
  if (hasUrl) return { outputUrl: result.outputUrl!.trim() };
  return { outputBase64: result.outputBase64, mimeType: result.mimeType };
}
function isInlineImageData(value: string): boolean { return /^data:image\/(?:png|jpeg);base64,/i.test(value); }
function isPermanentSaveConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; status?: unknown };
  return ["VERSION_CONFLICT", "LOCKED", "PROJECT_MISMATCH", "FORBIDDEN"].includes(String(value.code)) || [409, 423].includes(Number(value.status));
}
function rowFromJob(job: ImageJob): JobRow { return { ...job, payload: JSON.stringify(job.payload) }; }
