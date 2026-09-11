import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { lockProjectTransaction } from "@/lib/dbTransaction";
import { insertRowsReturningIds } from "@/lib/insertRows";
import { renewVideoReferenceConfigLeases } from "@/services/videoReferenceBridge";
import getPath from "@/utils/getPath";
import type { VideoSubmissionOutcome } from "@/lib/persistentVideoAdapter";

export type VideoJobStatus =
  | "SUBMITTING"
  | "SUBMITTED"
  | "POLLING"
  | "DOWNLOADING"
  | "SUCCEEDED"
  | "FAILED"
  | "RECONCILIATION_REQUIRED";

export interface VideoJobPayload {
  modelKey: string;
  providerFingerprint: string;
  projectId: number;
  scriptId: number;
  trackId: number;
  videoId: number;
  outputPath: string;
  config: unknown;
}

export type VideoJobRequest = Omit<VideoJobPayload, "videoId"> & { videoId?: never; videoTime?: number };

export interface VideoJob {
  id: number;
  idempotencyKey: string;
  payloadHash: string;
  modelKey: string;
  projectId: number;
  scriptId: number;
  trackId: number;
  videoId: number;
  outputPath: string;
  payload: VideoJobPayload;
  upstreamTaskId: string | null;
  resultUrl: string | null;
  status: VideoJobStatus;
  pollAttempts: number;
  queryFailures: number;
  downloadFailures: number;
  nextPollAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  submissionLeaseUntil: number | null;
  submissionOutcome: VideoSubmissionOutcome | null;
}

export interface VideoTaskProvider {
  /** Non-secret fingerprint of the endpoint and selected model binding. */
  fingerprint: string;
  /** URL-capable providers receive signed project-scoped references. */
  referenceTransport?: "base64" | "url";
  submit(config: unknown): Promise<{ taskId: string }>;
  query(taskId: string): Promise<{ status: "pending" | "succeeded" | "failed"; outputUrl?: string; error?: string }>;
}

export interface VideoJobDependencies {
  providerFor: (modelKey: string) => Promise<VideoTaskProvider>;
  download: (url: string, outputPath: string, job?: VideoJob) => Promise<void>;
  beforeSubmit?: (job: VideoJob, config: unknown) => Promise<void>;
  now?: () => number;
  maxConcurrent?: number;
  maxQueryFailures?: number;
  maxDownloadFailures?: number;
  initialPollDelayMs?: number;
  schedule?: boolean;
  /** Stable only for the lifetime of one process. It fences the sole submitter. */
  workerId?: string;
  submissionLeaseMs?: number;
}

export class VideoJobError extends Error {
  constructor(public readonly code: "CONFLICT" | "NOT_FOUND" | "PROJECT_MISMATCH" | "INVALID_INPUT" | "UNSUPPORTED_PROVIDER", message: string) {
    super(message);
    this.name = "VideoJobError";
  }
}

interface JobRow {
  id: number;
  idempotencyKey: string;
  payloadHash: string;
  modelKey: string;
  projectId: number;
  scriptId: number;
  trackId: number;
  videoId: number;
  outputPath: string;
  payload: string;
  upstreamTaskId: string | null;
  resultUrl: string | null;
  status: VideoJobStatus;
  pollAttempts: number;
  queryFailures: number;
  downloadFailures: number;
  nextPollAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  submissionOwner: string | null;
  submissionLeaseUntil: number | null;
  submissionOutcome: VideoSubmissionOutcome | null;
}

export async function ensureVideoJobsSchema(db: Knex): Promise<void> {
  if (isPostgres(db)) {
    await db.raw(`
      CREATE TABLE IF NOT EXISTS "ext_video_jobs" (
        id bigserial PRIMARY KEY,
        "idempotencyKey" text NOT NULL,
        "payloadHash" text NOT NULL,
        "modelKey" text NOT NULL,
        "projectId" bigint NOT NULL,
        "scriptId" bigint NOT NULL,
        "trackId" bigint NOT NULL,
        "videoId" bigint NOT NULL UNIQUE,
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
        "submissionOwner" text,
        "submissionLeaseUntil" bigint,
        "submissionOutcome" text,
        UNIQUE ("projectId", "idempotencyKey")
      )
    `);
    await db.raw(`CREATE INDEX IF NOT EXISTS "ext_video_jobs_status_poll_idx" ON "ext_video_jobs" (status, "nextPollAt")`);
    await db.raw(`CREATE INDEX IF NOT EXISTS "ext_video_jobs_project_script_track_idx" ON "ext_video_jobs" ("projectId", "scriptId", "trackId")`);
    await db.raw(`ALTER TABLE "ext_video_jobs" ADD COLUMN IF NOT EXISTS "submissionOwner" text`);
    await db.raw(`ALTER TABLE "ext_video_jobs" ADD COLUMN IF NOT EXISTS "submissionLeaseUntil" bigint`);
    await db.raw(`ALTER TABLE "ext_video_jobs" ADD COLUMN IF NOT EXISTS "submissionOutcome" text`);
    await db.raw(`CREATE INDEX IF NOT EXISTS "ext_video_jobs_submission_lease_idx" ON "ext_video_jobs" (status, "submissionLeaseUntil")`);
    return;
  }
  if (!(await db.schema.hasTable("ext_video_jobs"))) {
    await db.schema.createTable("ext_video_jobs", (table) => {
      table.increments("id").primary();
      table.text("idempotencyKey").notNullable();
      table.text("payloadHash").notNullable();
      table.text("modelKey").notNullable();
      table.integer("projectId").notNullable();
      table.integer("scriptId").notNullable();
      table.integer("trackId").notNullable();
      table.integer("videoId").notNullable().unique();
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
      table.text("submissionOwner");
      table.integer("submissionLeaseUntil");
      table.text("submissionOutcome");
      table.index(["status", "nextPollAt"]);
      table.index(["projectId", "scriptId", "trackId"]);
      table.unique(["projectId", "idempotencyKey"]);
    });
  }
  if (!(await db.schema.hasColumn("ext_video_jobs", "submissionOwner"))) await db.schema.alterTable("ext_video_jobs", (table) => table.text("submissionOwner"));
  if (!(await db.schema.hasColumn("ext_video_jobs", "submissionLeaseUntil"))) await db.schema.alterTable("ext_video_jobs", (table) => table.integer("submissionLeaseUntil"));
  if (!(await db.schema.hasColumn("ext_video_jobs", "submissionOutcome"))) await db.schema.alterTable("ext_video_jobs", (table) => table.text("submissionOutcome"));
}

function isPostgres(db: Knex | Knex.Transaction): boolean {
  return String((db.client as any)?.config?.client).toLowerCase() === "pg";
}

async function insertIds(trx: Knex.Transaction, table: string, row: Record<string, unknown>): Promise<number[]> {
  return isPostgres(trx) ? insertRowsReturningIds(trx, table, row) : trx(table).insert(row) as Promise<number[]>;
}

export class VideoJobService {
  private readonly now: () => number;
  private readonly maxConcurrent: number;
  private readonly maxQueryFailures: number;
  private readonly maxDownloadFailures: number;
  private readonly initialPollDelayMs: number;
  private readonly scheduleEnabled: boolean;
  private readonly workerId: string;
  private readonly submissionLeaseMs: number;
  private readonly active = new Map<number, Promise<VideoJob>>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private running = 0;
  private stopped = false;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly db: Knex,
    private readonly dependencies: VideoJobDependencies,
  ) {
    this.now = dependencies.now ?? Date.now;
    this.maxConcurrent = dependencies.maxConcurrent ?? 2;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 20) {
      throw new VideoJobError("INVALID_INPUT", "maxConcurrent 必须在 1 到 20 之间");
    }
    this.maxQueryFailures = dependencies.maxQueryFailures ?? 5;
    this.maxDownloadFailures = dependencies.maxDownloadFailures ?? 5;
    this.initialPollDelayMs = dependencies.initialPollDelayMs ?? 5_000;
    this.scheduleEnabled = dependencies.schedule ?? true;
    this.workerId = dependencies.workerId ?? randomUUID();
    this.submissionLeaseMs = dependencies.submissionLeaseMs ?? 120_000;
    if (!this.workerId || this.workerId.length > 250 || !Number.isSafeInteger(this.submissionLeaseMs) || this.submissionLeaseMs < 1_000 || this.submissionLeaseMs > 30 * 60_000) {
      throw new VideoJobError("INVALID_INPUT", "视频提交租约配置无效");
    }
  }

  async reserve(idempotencyKey: string, payload: VideoJobPayload, requestHash = hashPayload(payload)): Promise<{ job: VideoJob; created: boolean }> {
    this.assertIdempotencyKey(idempotencyKey);
    this.assertPayload(payload);
    return this.db.transaction(async (trx) => {
      await lockProjectTransaction(trx, payload.projectId);
      await this.assertOwnership(trx, payload);
      const existing = (await trx<JobRow>("ext_video_jobs").where({ projectId: payload.projectId, idempotencyKey }).first()) as JobRow | undefined;
      if (existing) {
        if (existing.payloadHash !== requestHash) {
          throw new VideoJobError("CONFLICT", "idempotencyKey 已用于不同的视频任务参数");
        }
        return { job: this.toJob(existing), created: false };
      }
      const existingVideo = await trx<JobRow>("ext_video_jobs").where({ videoId: payload.videoId }).first();
      if (existingVideo) throw new VideoJobError("CONFLICT", "该视频记录已有持久化任务");
      await this.assertTrackUnlockedForReservation(trx, payload);
      const time = this.now();
      const [id] = await insertIds(trx, "ext_video_jobs", {
        idempotencyKey,
        payloadHash: requestHash,
        modelKey: payload.modelKey,
        projectId: payload.projectId,
        scriptId: payload.scriptId,
        trackId: payload.trackId,
        videoId: payload.videoId,
        outputPath: payload.outputPath,
        payload: JSON.stringify(payload),
        status: "SUBMITTING",
        submissionOwner: this.workerId,
        submissionLeaseUntil: time + this.submissionLeaseMs,
        createdAt: time,
        updatedAt: time,
      });
      const row = await trx<JobRow>("ext_video_jobs").where({ id }).first();
      if (!row) throw new VideoJobError("NOT_FOUND", "视频任务保留失败");
      return { job: this.toJob(row), created: true };
    });
  }

  /** Atomically create the o_video row and its reservation, so concurrent retries cannot orphan a video row. */
  async reserveNewVideo(idempotencyKey: string, request: VideoJobRequest, requestHash = hashVideoJobRequest(request)): Promise<{ job: VideoJob; created: boolean }> {
    const [result] = await this.reserveNewVideos([{ idempotencyKey, request, requestHash }]);
    return result;
  }

  /** All request validation happens before either video rows or jobs are inserted. */
  async reserveNewVideos(
    items: Array<{ idempotencyKey: string; request: VideoJobRequest; requestHash?: string }>,
    transaction?: Knex.Transaction,
  ): Promise<Array<{ job: VideoJob; created: boolean }>> {
    if (!items.length) throw new VideoJobError("INVALID_INPUT", "至少需要一个视频任务");
    const operation = async (trx: Knex.Transaction) => {
      const normalized = items.map((item) => ({ ...item, requestHash: item.requestHash ?? hashVideoJobRequest(item.request) }));
      const keys = new Set<string>();
      for (const item of normalized) {
        this.assertIdempotencyKey(item.idempotencyKey);
        this.assertRequest(item.request);
        if (keys.has(`${item.request.projectId}:${item.idempotencyKey}`)) throw new VideoJobError("CONFLICT", "批量请求中的 idempotencyKey 重复");
        keys.add(`${item.request.projectId}:${item.idempotencyKey}`);
      }
      for (const projectId of [...new Set(normalized.map((item) => item.request.projectId))].sort((a, b) => a - b)) {
        await lockProjectTransaction(trx, projectId);
      }
      const existingRows: Array<JobRow | undefined> = [];
      for (const item of normalized) {
        await this.assertScriptAndTrack(trx, item.request);
        const existing = (await trx<JobRow>("ext_video_jobs").where({ projectId: item.request.projectId, idempotencyKey: item.idempotencyKey }).first()) as JobRow | undefined;
        if (existing && existing.payloadHash !== item.requestHash) throw new VideoJobError("CONFLICT", "idempotencyKey 已用于不同的视频任务参数");
        existingRows.push(existing);
      }
      for (let index = 0; index < normalized.length; index += 1) {
        if (!existingRows[index]) await this.assertTrackUnlockedForReservation(trx, normalized[index].request);
      }
      const results: Array<{ job: VideoJob; created: boolean }> = [];
      for (let index = 0; index < normalized.length; index += 1) {
        const item = normalized[index];
        const existing = existingRows[index];
        if (existing) {
          results.push({ job: this.toJob(existing), created: false });
          continue;
        }
        const [videoId] = await insertIds(trx, "o_video", { filePath: item.request.outputPath, time: item.request.videoTime ?? this.now(), state: "生成中",
          scriptId: item.request.scriptId, projectId: item.request.projectId, videoTrackId: item.request.trackId });
        const payload: VideoJobPayload = { ...item.request, videoId };
        const time = this.now();
        const [id] = await insertIds(trx, "ext_video_jobs", {
          idempotencyKey: item.idempotencyKey, payloadHash: item.requestHash, modelKey: payload.modelKey, projectId: payload.projectId,
          scriptId: payload.scriptId, trackId: payload.trackId, videoId, outputPath: payload.outputPath, payload: JSON.stringify(payload),
          status: "SUBMITTING", submissionOwner: this.workerId, submissionLeaseUntil: time + this.submissionLeaseMs,
          createdAt: time, updatedAt: time,
        });
        const row = await trx<JobRow>("ext_video_jobs").where({ id }).first();
        if (!row) throw new VideoJobError("NOT_FOUND", "视频任务保留失败");
        results.push({ job: this.toJob(row), created: true });
      }
      return results;
    };
    return transaction ? operation(transaction) : this.db.transaction(operation);
  }

  /** Only call this from the request that created the reservation. */
  async submitReserved(jobId: number): Promise<VideoJob> {
    return this.runExclusive(jobId, () => this.runJob(jobId, true));
  }

  /** Manual recovery continuation. This path can only query/download an existing receipt and never submits. */
  async continueKnown(jobId: number): Promise<VideoJob> {
    this.assertPositiveInteger(jobId, "jobId");
    return this.runExclusive(jobId, () => this.runJob(jobId, false));
  }

  /** Retry only the download for a known upstream receipt. It never queries
   * or submits the provider, and accepts no job without both durable fields. */
  async retryDownload(input: { projectId: number; scriptId: number; trackId: number; jobId: number }): Promise<VideoJob> {
    this.assertPositiveInteger(input.projectId, "projectId");
    this.assertPositiveInteger(input.scriptId, "scriptId");
    this.assertPositiveInteger(input.trackId, "trackId");
    this.assertPositiveInteger(input.jobId, "jobId");
    // Authorize before sharing an in-flight promise. Otherwise a caller from
    // another project could reuse the first caller's already-authorized work.
    const owned = await this.get(input.jobId);
    if (owned.projectId !== input.projectId || owned.scriptId !== input.scriptId || owned.trackId !== input.trackId) throw new VideoJobError("PROJECT_MISMATCH", "下载任务不属于当前项目、剧集或轨道");
    return this.runExclusive(input.jobId, async () => {
      let job = await this.get(input.jobId);
      if (job.projectId !== input.projectId || job.scriptId !== input.scriptId || job.trackId !== input.trackId) throw new VideoJobError("PROJECT_MISMATCH", "下载任务不属于当前项目、剧集或轨道");
      if (job.status === "SUCCEEDED") return job;
      if (!job.upstreamTaskId || !job.resultUrl) throw new VideoJobError("CONFLICT", "视频任务没有已知的上游任务和结果地址，不能仅重试下载");
      if (job.status !== "DOWNLOADING" && job.status !== "RECONCILIATION_REQUIRED") throw new VideoJobError("CONFLICT", "当前视频任务不处于可重试下载状态");
      if (job.status === "RECONCILIATION_REQUIRED") {
        await this.db("ext_video_jobs").where({ id: job.id, projectId: job.projectId, status: "RECONCILIATION_REQUIRED" }).whereNotNull("upstreamTaskId").whereNotNull("resultUrl").update({
          status: "DOWNLOADING", downloadFailures: 0, nextPollAt: this.now(), lastError: null, updatedAt: this.now(),
        });
        job = await this.get(job.id);
      }
      return this.download(job, job.resultUrl!);
    });
  }

  /** Resume queries/downloads only. A live submission lease is left to its creating process. */
  async resumeDueJobs(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    await this.db.transaction(async (trx) => {
      const submitting = await trx<JobRow>("ext_video_jobs").where({ status: "SUBMITTING" });
      for (const row of submitting) {
        if (row.upstreamTaskId) {
          await trx("ext_video_jobs").where({ id: row.id, status: "SUBMITTING" }).update({ status: "SUBMITTED", nextPollAt: now, updatedAt: now, lastError: null });
          continue;
        }
        if (row.submissionLeaseUntil != null && Number(row.submissionLeaseUntil) > now) continue;
        await this.markReconciliation(trx, row, "视频提交租约已到期且没有上游任务 ID，需要人工核对", true);
      }
    });
    const active = await this.db<JobRow>("ext_video_jobs").whereIn("status", ["SUBMITTED", "POLLING", "DOWNLOADING"]);
    const due = active.filter((row) => row.nextPollAt == null || row.nextPollAt <= now);
    for (const row of active.filter((row) => row.nextPollAt != null && row.nextPollAt > now)) this.schedule(row.id, row.nextPollAt!);
    await Promise.all(due.map((row) => this.runExclusive(row.id, () => this.runJob(row.id, false))));
  }

  async get(jobId: number): Promise<VideoJob> {
    this.assertPositiveInteger(jobId, "jobId");
    const row = await this.db<JobRow>("ext_video_jobs").where({ id: jobId }).first();
    if (!row) throw new VideoJobError("NOT_FOUND", "视频任务不存在");
    return this.toJob(row);
  }

  async findByIdempotency(projectId: number, idempotencyKey: string): Promise<VideoJob | undefined> {
    this.assertPositiveInteger(projectId, "projectId");
    this.assertIdempotencyKey(idempotencyKey);
    const row = await this.db<JobRow>("ext_video_jobs").where({ projectId, idempotencyKey }).first();
    return row ? this.toJob(row) : undefined;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async runJob(jobId: number, maySubmit: boolean): Promise<VideoJob> {
    const row = await this.db<JobRow>("ext_video_jobs").where({ id: jobId }).first();
    if (!row) throw new VideoJobError("NOT_FOUND", "视频任务不存在");
    let job = this.toJob(row);
    if (["SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED"].includes(job.status)) return job;

    if (!job.upstreamTaskId) {
      if (!maySubmit) return job;
      const reserved = await this.db.transaction(async (trx) => {
        const current = await trx<JobRow>("ext_video_jobs").where({ id: jobId }).forUpdate().first();
        if (!current) throw new VideoJobError("NOT_FOUND", "视频任务不存在");
        if (current.upstreamTaskId) return current;
        if (current.status !== "SUBMITTING") return current;
        if (current.submissionOwner !== this.workerId) throw new VideoJobError("CONFLICT", "只有创建该保留任务的进程可以提交视频");
        if (current.submissionLeaseUntil == null || Number(current.submissionLeaseUntil) <= this.now()) {
          throw new VideoJobError("CONFLICT", "视频提交租约已到期，需要人工核对");
        }
        return current;
      });
      job = this.toJob(reserved);
      if (job.upstreamTaskId) return this.pollOrDownload(job);
      if (job.status !== "SUBMITTING") return job;
      try {
        const provider = await this.providerFor(job.modelKey);
        if (provider.fingerprint !== job.payload.providerFingerprint) {
          await this.db.transaction((trx) => this.markReconciliation(trx, rowFromJob(job), "当前供应商端点或模型绑定已变化，不能提交旧保留任务"));
          return this.get(jobId);
        }
        let submitConfig = job.payload.config;
        if (provider.referenceTransport === "url") {
          submitConfig = await renewVideoReferenceConfigLeases(this.db, submitConfig, {
            rootDir: getPath("oss"),
            publicOrigin: String(process.env.TOONFLOW_MEDIA_PUBLIC_ORIGIN || ""),
            secret: String(process.env.TOONFLOW_MEDIA_BRIDGE_SECRET || ""),
          });
          job = { ...job, payload: { ...job.payload, config: submitConfig } };
        }
        await this.dependencies.beforeSubmit?.(job, submitConfig);
        const submitted = await provider.submit(submitConfig);
        if (!submitted?.taskId) throw new Error("上游未返回任务 ID");
        await this.db.transaction(async (trx) => {
          const updated = await trx("ext_video_jobs")
            .where({ id: job.id, submissionOwner: this.workerId })
            .whereNull("upstreamTaskId")
            .update({
              upstreamTaskId: submitted.taskId,
              submissionOutcome: "submitted",
              status: "SUBMITTED",
              payload: JSON.stringify(compactVideoPayload(job.payload)),
              nextPollAt: this.now(),
              updatedAt: this.now(),
              lastError: null,
            });
          if (updated) {
            await trx("o_video").where({ id: job.videoId, projectId: job.projectId, scriptId: job.scriptId, videoTrackId: job.trackId }).update({ state: "生成中", errorReason: null });
          }
        });
      } catch (error) {
        if (error instanceof VideoJobError && error.code === "CONFLICT") throw error;
        const outcome = submissionOutcome(error);
        if (outcome === "not_submitted" || outcome === "rejected") {
          await this.failUnsubmitted(job, `${outcome === "rejected" ? "上游拒绝视频任务" : "视频任务未提交到上游"}：${errorMessage(error)}`, outcome);
        } else {
          await this.db.transaction(async (trx) => {
            const current = await trx<JobRow>("ext_video_jobs").where({ id: job.id }).first();
            if (current && !current.upstreamTaskId && current.status === "SUBMITTING" && current.submissionOwner === this.workerId) await this.markReconciliation(trx, current, `提交结果不确定：${errorMessage(error)}`, true);
          });
        }
        return this.get(jobId);
      }
      job = await this.get(jobId);
    }
    return this.pollOrDownload(job);
  }

  private async pollOrDownload(job: VideoJob): Promise<VideoJob> {
    if (job.status === "DOWNLOADING" && job.resultUrl) return this.download(job, job.resultUrl);
    let provider: VideoTaskProvider;
    try {
      provider = await this.providerFor(job.modelKey);
    } catch (error) {
      await this.db.transaction((trx) => this.markReconciliation(trx, rowFromJob(job), `供应商不可恢复：${errorMessage(error)}`));
      return this.get(job.id);
    }
    if (provider.fingerprint !== job.payload.providerFingerprint) {
      await this.db.transaction((trx) => this.markReconciliation(trx, rowFromJob(job), "当前供应商端点或模型绑定已变化，不能查询旧任务"));
      return this.get(job.id);
    }
    let result: Awaited<ReturnType<VideoTaskProvider["query"]>>;
    try {
      result = await provider.query(job.upstreamTaskId!);
    } catch (error) {
      return this.deferQuery(job, errorMessage(error));
    }
    if (result.status === "pending") {
      return this.deferPoll(job);
    }
    if (result.status === "failed") {
      return this.fail(job, result.error ?? "上游视频任务失败");
    }
    if (!result.outputUrl) {
      return this.deferQuery(job, "上游任务成功但未返回视频地址");
    }
    await this.db("ext_video_jobs").where({ id: job.id }).update({
      status: "DOWNLOADING",
      resultUrl: result.outputUrl,
      nextPollAt: this.now(),
      updatedAt: this.now(),
      lastError: null,
    });
    return this.download(await this.get(job.id), result.outputUrl);
  }

  private async download(job: VideoJob, url: string): Promise<VideoJob> {
    try {
      await this.dependencies.download(url, job.outputPath, job);
      await this.db.transaction(async (trx) => {
        await trx("ext_video_jobs").where({ id: job.id }).update({
          status: "SUCCEEDED", submissionOutcome: "submitted", payload: JSON.stringify(compactVideoPayload(job.payload)), nextPollAt: null, updatedAt: this.now(), lastError: null,
        });
        await trx("o_video").where({ id: job.videoId, projectId: job.projectId, scriptId: job.scriptId, videoTrackId: job.trackId }).update({
          state: "生成成功", filePath: job.outputPath, errorReason: null,
        });
      });
    } catch (error) {
      const failures = job.downloadFailures + 1;
      const message = `下载视频失败：${errorMessage(error)}`;
      if (failures >= this.maxDownloadFailures) {
        await this.db.transaction((trx) => this.markReconciliation(trx, rowFromJob(job), `下载视频连续失败：${message}`));
        return this.get(job.id);
      }
      const nextPollAt = this.now() + this.backoff(failures);
      await this.db("ext_video_jobs").where({ id: job.id }).update({
        status: "DOWNLOADING", downloadFailures: failures, nextPollAt, lastError: message, updatedAt: this.now(),
      });
      this.schedule(job.id, nextPollAt);
    }
    return this.get(job.id);
  }

  private async deferPoll(job: VideoJob): Promise<VideoJob> {
    const attempts = job.pollAttempts + 1;
    const nextPollAt = this.now() + this.backoff(attempts);
    await this.db("ext_video_jobs").where({ id: job.id }).update({
      status: "POLLING", pollAttempts: attempts, nextPollAt, updatedAt: this.now(), lastError: null,
    });
    this.schedule(job.id, nextPollAt);
    return this.get(job.id);
  }

  private async deferQuery(job: VideoJob, message: string): Promise<VideoJob> {
    const failures = job.queryFailures + 1;
    if (failures >= this.maxQueryFailures) {
      await this.db.transaction((trx) => this.markReconciliation(trx, rowFromJob(job), `查询上游任务连续失败：${message}`));
      return this.get(job.id);
    }
    const nextPollAt = this.now() + this.backoff(failures);
    await this.db("ext_video_jobs").where({ id: job.id }).update({
      status: "POLLING", queryFailures: failures, nextPollAt, updatedAt: this.now(), lastError: `查询上游任务失败：${message}`,
    });
    this.schedule(job.id, nextPollAt);
    return this.get(job.id);
  }

  /** Mark only a reservation with an explicit provider non-submission result.
   * The NULL upstream predicate protects a task that may have received a task
   * ID through another racing worker from being overwritten as FAILED.
   */
  private async failUnsubmitted(job: VideoJob, message: string, outcome: "not_submitted" | "rejected"): Promise<VideoJob> {
    await this.db.transaction(async (trx) => {
      const changed = await trx("ext_video_jobs").where({ id: job.id, status: "SUBMITTING", submissionOwner: this.workerId }).whereNull("upstreamTaskId").update({
        status: "FAILED", submissionOutcome: outcome, payload: JSON.stringify(compactVideoPayload(job.payload)), nextPollAt: null, lastError: message, updatedAt: this.now(),
      });
      if (changed) await trx("o_video").where({ id: job.videoId, projectId: job.projectId, scriptId: job.scriptId, videoTrackId: job.trackId }).update({ state: "生成失败", errorReason: message });
    });
    return this.get(job.id);
  }

  private async fail(job: VideoJob, message: string): Promise<VideoJob> {
    await this.db.transaction(async (trx) => {
      await trx("ext_video_jobs").where({ id: job.id }).update({ status: "FAILED", ...(job.upstreamTaskId ? { submissionOutcome: "submitted" } : {}), payload: JSON.stringify(compactVideoPayload(job.payload)), nextPollAt: null, lastError: message, updatedAt: this.now() });
      await trx("o_video").where({ id: job.videoId, projectId: job.projectId, scriptId: job.scriptId, videoTrackId: job.trackId }).update({
        state: "生成失败", errorReason: message,
      });
    });
    return this.get(job.id);
  }

  private async markReconciliation(trx: Knex.Transaction, row: JobRow, message: string, onlyWithoutUpstream = false): Promise<void> {
    let query = trx("ext_video_jobs").where({ id: row.id });
    if (onlyWithoutUpstream) query = query.whereNull("upstreamTaskId");
    const updated = await query.update({
      status: "RECONCILIATION_REQUIRED", submissionOutcome: row.upstreamTaskId ? "submitted" : "unknown", payload: compactPayloadText(row.payload), nextPollAt: null, lastError: message, updatedAt: this.now(),
    });
    if (updated) await trx("o_video").where({ id: row.videoId, projectId: row.projectId, scriptId: row.scriptId, videoTrackId: row.trackId }).update({
      state: "需人工核对", errorReason: message,
    });
  }

  private async assertOwnership(trx: Knex.Transaction, payload: VideoJobPayload): Promise<void> {
    await this.assertScriptAndTrack(trx, payload);
    const video = await trx("o_video").where({ id: payload.videoId, projectId: payload.projectId, scriptId: payload.scriptId, videoTrackId: payload.trackId }).first();
    if (!video) throw new VideoJobError("PROJECT_MISMATCH", "视频记录不属于当前项目、剧集或轨道");
    if (video.filePath !== payload.outputPath) throw new VideoJobError("CONFLICT", "视频输出路径与保留任务不一致");
  }

  private async providerFor(modelKey: string): Promise<VideoTaskProvider> {
    try {
      return await this.dependencies.providerFor(modelKey);
    } catch (error) {
      if (error instanceof VideoJobError) throw error;
      throw new VideoJobError("UNSUPPORTED_PROVIDER", errorMessage(error));
    }
  }

  private runExclusive(jobId: number, work: () => Promise<VideoJob>): Promise<VideoJob> {
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
    try {
      return await work();
    } finally {
      this.running -= 1;
      this.waiters.shift()?.();
    }
  }

  private schedule(jobId: number, dueAt: number): void {
    if (this.stopped || !this.scheduleEnabled) return;
    const existing = this.timers.get(jobId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(jobId);
      void this.runExclusive(jobId, () => this.runJob(jobId, false));
    }, Math.max(0, dueAt - this.now()));
    this.timers.set(jobId, timer);
  }

  private backoff(attempt: number): number {
    return Math.min(60_000, this.initialPollDelayMs * 2 ** Math.min(attempt - 1, 6));
  }

  private toJob(row: JobRow): VideoJob {
    let payload: VideoJobPayload;
    try { payload = JSON.parse(row.payload) as VideoJobPayload; } catch { throw new VideoJobError("INVALID_INPUT", "持久化视频任务内容损坏"); }
    return {
      ...row,
      id: Number(row.id),
      projectId: Number(row.projectId),
      scriptId: Number(row.scriptId),
      trackId: Number(row.trackId),
      videoId: Number(row.videoId),
      pollAttempts: Number(row.pollAttempts),
      queryFailures: Number(row.queryFailures),
      downloadFailures: Number(row.downloadFailures),
      nextPollAt: row.nextPollAt == null ? null : Number(row.nextPollAt),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      submissionLeaseUntil: row.submissionLeaseUntil == null ? null : Number(row.submissionLeaseUntil),
      submissionOutcome: row.submissionOutcome ?? null,
      payload,
    };
  }

  private assertPayload(payload: VideoJobPayload): void {
    if (!payload || typeof payload !== "object" || typeof payload.modelKey !== "string" || !payload.modelKey.trim()
      || typeof payload.providerFingerprint !== "string" || !payload.providerFingerprint.trim() || typeof payload.outputPath !== "string" || !payload.outputPath) {
      throw new VideoJobError("INVALID_INPUT", "视频任务参数不完整");
    }
    this.assertPositiveInteger(payload.projectId, "projectId");
    this.assertPositiveInteger(payload.scriptId, "scriptId");
    this.assertPositiveInteger(payload.trackId, "trackId");
    this.assertPositiveInteger(payload.videoId, "videoId");
  }

  private assertRequest(request: VideoJobRequest): void {
    this.assertPayload({ ...request, videoId: 1 });
  }

  private async assertScriptAndTrack(trx: Knex.Transaction, payload: Pick<VideoJobPayload, "projectId" | "scriptId" | "trackId">): Promise<void> {
    const script = await trx("o_script").where({ id: payload.scriptId, projectId: payload.projectId }).first();
    if (!script) throw new VideoJobError("PROJECT_MISMATCH", "剧集不属于当前项目");
    const track = await trx("o_videoTrack").where({ id: payload.trackId, projectId: payload.projectId, scriptId: payload.scriptId }).first();
    if (!track) throw new VideoJobError("PROJECT_MISMATCH", "视频轨道不属于当前项目或剧集");
  }

  /** New reservations are blocked by a locked storyboard; accepted jobs keep their normal lifecycle. */
  private async assertTrackUnlockedForReservation(trx: Knex.Transaction, payload: Pick<VideoJobPayload, "projectId" | "scriptId" | "trackId">): Promise<void> {
    const locked = await trx("o_storyboard as storyboard")
      .join("ext_entity_state as state", "state.entityId", "storyboard.id")
      .where({
        "storyboard.projectId": payload.projectId,
        "storyboard.scriptId": payload.scriptId,
        "storyboard.trackId": payload.trackId,
        "state.entityType": "storyboard",
        "state.projectId": payload.projectId,
        "state.locked": 1,
      })
      .first("storyboard.id");
    if (locked) throw new VideoJobError("CONFLICT", "轨道关联的分镜已锁定，不能新建视频任务");
  }

  private assertIdempotencyKey(value: string): void {
    if (typeof value !== "string" || value.length < 8 || value.length > 200) throw new VideoJobError("INVALID_INPUT", "idempotencyKey 不合法");
  }

  private assertPositiveInteger(value: unknown, name: string): void {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new VideoJobError("INVALID_INPUT", `${name} 必须是正安全整数`);
  }
}

export function hashVideoJobRequest(payload: Pick<VideoJobPayload, "modelKey" | "projectId" | "scriptId" | "trackId" | "providerFingerprint" | "config">): string {
  return createHash("sha256").update(stableJson(normalizeVideoJobHashPayload(payload))).digest("hex");
}

/** Signed bridge URLs and their rotating expiries are delivery credentials,
 * not business identity. Legacy base64 references remain byte-for-byte hashed. */
function normalizeVideoJobHashPayload(payload: Pick<VideoJobPayload, "modelKey" | "projectId" | "scriptId" | "trackId" | "providerFingerprint" | "config">): typeof payload {
  if (!payload.config || typeof payload.config !== "object" || Array.isArray(payload.config)) return payload;
  const config = payload.config as Record<string, unknown>;
  if (!Array.isArray(config.referenceList)) return payload;
  const referenceList = config.referenceList.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const reference = value as Record<string, unknown>;
    if (typeof reference.url !== "string" || !/\/media-bridge\//.test(reference.url)) return value;
    const { url: _url, leaseId: _leaseId, expiresAt: _expiresAt, ...stableReference } = reference;
    return stableReference;
  });
  return { ...payload, config: { ...config, referenceList } };
}

function hashPayload(payload: VideoJobPayload): string {
  return hashVideoJobRequest(payload);
}

/** Keep first-submit media only in memory; persisted tasks retain non-secret reference evidence. */
function compactVideoPayload(payload: VideoJobPayload): VideoJobPayload {
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

function compactPayloadText(payloadText: string): string {
  try { return JSON.stringify(compactVideoPayload(JSON.parse(payloadText) as VideoJobPayload)); }
  catch { return payloadText; }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function submissionOutcome(error: unknown): VideoSubmissionOutcome | undefined {
  const value = error && typeof error === "object" ? (error as { submissionOutcome?: unknown }).submissionOutcome : undefined;
  return value === "not_submitted" || value === "rejected" || value === "submitted" || value === "unknown" ? value : undefined;
}

function rowFromJob(job: VideoJob): JobRow {
  return { ...job, submissionOwner: null, payload: JSON.stringify(job.payload) };
}
