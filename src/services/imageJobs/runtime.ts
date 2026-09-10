import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { insertRowsReturningIds } from "../../lib/insertRows";
import { isPostgres, lockProjectTransaction } from "../../lib/dbTransaction";
import type { PersistentImageTaskProvider } from "../../lib/persistentImageAdapter";
import { ensureImageJobsSchema, ImageJobError, ImageJobService, type ImageJob } from ".";
import { resolveImageFlowOwner, ImageFlowWorkspaceError } from "../imageFlowWorkspace";
import { assertImageMediaProject, resolveImageMediaOwnership, MediaOwnershipError } from "../../lib/mediaOwnership";

const BINDINGS = "ext_image_job_bindings";

export type ImageGenerationTarget =
  | { kind: "asset"; id: number; scriptId?: number; expectedVersion?: number }
  | { kind: "storyboard"; id: number; scriptId: number; expectedVersion?: number }
  | { kind: "flow"; id: string | number; scriptId?: number; expectedVersion?: number };

export interface PrepareImageGenerationInput {
  generationKey: string;
  projectId: number;
  modelKey: string;
  config: {
    prompt: string;
    referenceList?: Array<{ type: "image"; base64: string }>;
    size: string;
    aspectRatio: string;
  };
  target: ImageGenerationTarget;
  builtinRun?: { id: string; inputRevision: number };
  outputPath?: string;
}

export type ImageGenerationStatus = "succeeded" | "pending" | "failed" | "needs_reconciliation";

export interface ImageGenerationReceipt {
  jobId: number;
  generationKey: string;
  projectId: number;
  target: ImageGenerationTarget;
  status: ImageGenerationStatus;
  upstreamTaskId?: string;
  artifactPath?: string;
  selected?: boolean;
  error?: string;
  reused?: boolean;
}

export interface ImageGenerationServiceOptions {
  db: Knex;
  resolveModel?(modelKey: string, referenceCount: number): Promise<string>;
  validateConfig?(modelKey: string, config: PrepareImageGenerationInput["config"]): void | Promise<void>;
  providerFor(modelKey: string): Promise<PersistentImageTaskProvider>;
  download(url: string, outputPath: string): Promise<void>;
  getSmallImageUrl?(path: string): Promise<string>;
  uuid?(): string;
  now?(): number;
  pollMs?: number;
}

interface BindingContext {
  contractVersion: 1;
  requestedModelKey?: string;
  target: ImageGenerationTarget;
  expectedVersion: number;
  targetSignature: string;
  previousImageId?: number | null;
  previousFilePath?: string | null;
  previousState?: string | null;
  builtinRun?: { id: string; inputRevision: number };
}

interface BindingRow {
  jobId: number | string;
  projectId: number | string;
  scriptId: number | string | null;
  targetKind: "asset" | "storyboard" | "flow";
  targetId: string;
  expectedVersion: number | string;
  claimVersion: number | string | null;
  claimToken: string | null;
  targetSignature: string;
  previousImageId: number | string | null;
  previousFilePath: string | null;
  previousState: string | null;
  runId: string | null;
  runInputRevision: number | string | null;
  candidateImageId: number | string | null;
  artifactPath: string | null;
  selected: number | boolean;
  state: string;
  error: string | null;
  createdAt: number | string;
  updatedAt: number | string;
}

export class ImageGenerationError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "PROJECT_MISMATCH" | "VERSION_CONFLICT" | "LOCKED" | "CONFLICT", message: string, public readonly status = 400) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

export async function ensureProductionImageJobSchema(db: Knex): Promise<void> {
  await ensureImageJobsSchema(db);
  if (isPostgres(db)) {
    await db.raw(`
      CREATE TABLE IF NOT EXISTS "${BINDINGS}" (
        "jobId" bigint PRIMARY KEY REFERENCES "ext_image_jobs"(id) ON DELETE CASCADE,
        "projectId" bigint NOT NULL,
        "scriptId" bigint,
        "targetKind" text NOT NULL,
        "targetId" text NOT NULL,
        "expectedVersion" bigint NOT NULL,
        "claimVersion" bigint,
        "claimToken" text,
        "targetSignature" text NOT NULL,
        "previousImageId" bigint,
        "previousFilePath" text,
        "previousState" text,
        "runId" text,
        "runInputRevision" bigint,
        "candidateImageId" bigint,
        "artifactPath" text,
        selected boolean NOT NULL DEFAULT false,
        state text NOT NULL,
        error text,
        "createdAt" bigint NOT NULL,
        "updatedAt" bigint NOT NULL
      )
    `);
    await db.raw(`CREATE INDEX IF NOT EXISTS "ext_image_job_bindings_project_target_idx" ON "${BINDINGS}" ("projectId", "targetKind", "targetId", "createdAt")`);
    await db.raw(`CREATE INDEX IF NOT EXISTS "ext_image_job_bindings_artifact_idx" ON "${BINDINGS}" ("artifactPath") WHERE "artifactPath" IS NOT NULL`);
    await db.raw(`ALTER TABLE "${BINDINGS}" ADD COLUMN IF NOT EXISTS "runId" text`);
    await db.raw(`ALTER TABLE "${BINDINGS}" ADD COLUMN IF NOT EXISTS "runInputRevision" bigint`);
    return;
  }
  if (!(await db.schema.hasTable(BINDINGS))) {
    await db.schema.createTable(BINDINGS, (table) => {
      table.integer("jobId").primary();
      table.integer("projectId").notNullable();
      table.integer("scriptId");
      table.text("targetKind").notNullable();
      table.text("targetId").notNullable();
      table.integer("expectedVersion").notNullable();
      table.integer("claimVersion");
      table.text("claimToken");
      table.text("targetSignature").notNullable();
      table.integer("previousImageId");
      table.text("previousFilePath");
      table.text("previousState");
      table.text("runId");
      table.integer("runInputRevision");
      table.integer("candidateImageId");
      table.text("artifactPath");
      table.boolean("selected").notNullable().defaultTo(false);
      table.text("state").notNullable();
      table.text("error");
      table.integer("createdAt").notNullable();
      table.integer("updatedAt").notNullable();
      table.index(["projectId", "targetKind", "targetId", "createdAt"]);
      table.index(["artifactPath"]);
    });
  }
}

/** Returns the owning project for both selected and saved-but-unselected generated images. */
export async function resolveImageArtifactProject(db: Knex, filePath: string): Promise<number | undefined> {
  try { return (await resolveImageMediaOwnership(db, filePath)).projectId; }
  catch (error) { if (error instanceof MediaOwnershipError) return undefined; throw error; }
}

export async function assertImageArtifactProject(db: Knex, projectId: number, filePath: string): Promise<string> {
  try { return await assertImageMediaProject(db, projectId, filePath); }
  catch (error) { if (error instanceof MediaOwnershipError) throw new ImageGenerationError("PROJECT_MISMATCH", "图片引用不属于当前项目或存在归属冲突", 403); throw error; }
}

export class ImageGenerationService {
  private readonly db: Knex;
  private readonly options: ImageGenerationServiceOptions;
  private readonly jobs: ImageJobService;
  private readonly now: () => number;
  private readonly pollMs: number;
  private schema?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: ImageGenerationServiceOptions) {
    this.db = options.db;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.pollMs = Math.max(10, Math.floor(options.pollMs ?? 1_000));
    this.jobs = new ImageJobService({
      db: options.db,
      providerFor: options.providerFor,
      download: options.download,
      onSaved: (job, trx) => this.bindSavedArtifact(job, trx),
      now: this.now,
      initialPollDelayMs: this.pollMs,
      schedule: false,
    });
  }

  async prepare(input: PrepareImageGenerationInput): Promise<ImageGenerationReceipt> {
    await this.ensure();
    this.assertPrepareInput(input);
    const existing = await this.jobs.findByIdempotency(input.projectId, input.generationKey);
    const context = existing ? this.contextForExisting(existing, input) : {
      ...(await this.readBindingContext(input)), requestedModelKey: input.modelKey,
      ...(input.builtinRun ? { builtinRun: normalizeBuiltinRun(input.builtinRun) } : {}),
    };
    const effectiveModelKey = existing?.modelKey ?? await this.resolveEffectiveModel(input.modelKey, input.config.referenceList?.length ?? 0);
    if (!existing && this.options.validateConfig) {
      try { await this.options.validateConfig(effectiveModelKey, input.config); }
      catch (error) { throw new ImageGenerationError("INVALID_INPUT", error instanceof Error ? error.message : String(error)); }
    }
    const outputPath = existing?.outputPath ?? input.outputPath ?? this.defaultOutputPath(input);
    const reserved = await this.jobs.reserve({
      projectId: input.projectId,
      modelKey: effectiveModelKey,
      idempotencyKey: input.generationKey,
      config: normalizeConfig(input.config),
      outputPath,
      context,
    });
    try {
      await this.ensureBinding(reserved.job, context);
    } catch (error) {
      await this.recordBindingFailure(reserved.job, context, error).catch(() => undefined);
      throw error;
    }
    return { ...(await this.receipt(reserved.job)), reused: reserved.reused };
  }

  async get(input: { projectId: number; jobId?: number; generationKey?: string }): Promise<ImageGenerationReceipt> {
    await this.ensure();
    let job: ImageJob | undefined;
    if (input.jobId !== undefined) job = await this.jobs.get(input.jobId);
    else if (input.generationKey) job = await this.jobs.findByIdempotency(input.projectId, input.generationKey);
    else throw new ImageGenerationError("INVALID_INPUT", "jobId 或 generationKey 必须提供");
    if (!job) throw new ImageGenerationError("NOT_FOUND", "图片任务不存在", 404);
    if (job.projectId !== input.projectId) throw new ImageGenerationError("PROJECT_MISMATCH", "图片任务不属于当前项目", 403);
    await this.syncTerminal(job);
    return this.receipt(await this.jobs.get(job.id));
  }

  /** Release only a reservation that has never been submitted to the provider. */
  async cancelPrepared(input: { projectId: number; jobId: number; reason: string }): Promise<void> {
    await this.ensure();
    const changed = await this.db("ext_image_jobs").where({ id: input.jobId, projectId: input.projectId, status: "RESERVED" }).whereNull("upstreamTaskId")
      .update({ status: "FAILED", lastError: input.reason, nextPollAt: null, updatedAt: this.now() });
    if (changed) await this.syncTerminal(await this.jobs.get(input.jobId));
  }

  async submitAndWait(input: { projectId: number; jobId: number; maxWaitMs?: number; signal?: AbortSignal }): Promise<ImageGenerationReceipt> {
    await this.ensure();
    let job = await this.jobs.get(input.jobId);
    if (job.projectId !== input.projectId) throw new ImageGenerationError("PROJECT_MISMATCH", "图片任务不属于当前项目", 403);
    const deadline = this.now() + Math.max(0, Math.floor(input.maxWaitMs ?? 10 * 60_000));
    if (job.status === "RESERVED" && !input.signal?.aborted) job = await this.jobs.submitReserved(job.id);
    while (!terminal(job.status) && this.now() < deadline && !input.signal?.aborted) {
      const delay = job.nextPollAt == null ? this.pollMs : Math.max(10, Math.min(this.pollMs, job.nextPollAt - this.now()));
      await wait(delay, input.signal);
      await this.jobs.resumeDueJobs();
      job = await this.jobs.get(job.id);
    }
    await this.syncTerminal(job);
    return this.receipt(await this.jobs.get(job.id));
  }

  async prepareAndSubmit(input: PrepareImageGenerationInput, maxWaitMs?: number): Promise<ImageGenerationReceipt> {
    const prepared = await this.prepare(input);
    return this.submitAndWait({ projectId: input.projectId, jobId: prepared.jobId, maxWaitMs });
  }

  async recover(): Promise<void> {
    await this.ensure();
    const orphans = await this.db("ext_image_jobs as job").leftJoin(`${BINDINGS} as binding`, "binding.jobId", "job.id").whereNull("binding.jobId").select("job.id");
    for (const row of orphans) {
      const job = await this.jobs.get(Number(row.id));
      const context = job.payload.context as BindingContext | undefined;
      if (!context || context.contractVersion !== 1 || !context.target) {
        await this.db("ext_image_jobs").where({ id: job.id }).whereNotIn("status", ["FAILED", "RECONCILIATION_REQUIRED"]).update({ status: "RECONCILIATION_REQUIRED", lastError: "图片任务缺少可恢复的目标绑定上下文", nextPollAt: null, updatedAt: this.now() });
        continue;
      }
      if (job.status === "RESERVED") {
        try { await this.ensureBinding(job, context); }
        catch (error) { await this.recordBindingFailure(job, context, error).catch(() => undefined); }
      } else {
        await this.recordBindingFailure(job, context, new Error("图片任务提交后缺少目标绑定，需要人工核对"), "RECONCILIATION_REQUIRED").catch(() => undefined);
      }
    }
    await this.jobs.resumeDueJobs();
    const rows = await this.db("ext_image_jobs").whereIn("status", ["SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED"]);
    for (const row of rows) await this.syncTerminal(await this.jobs.get(Number(row.id)));
  }

  async continueKnown(jobId: number): Promise<ImageJob> {
    await this.ensure();
    const job = await this.jobs.continueKnown(jobId);
    await this.syncTerminal(job);
    return this.jobs.get(jobId);
  }

  start(): void {
    if (this.timer) return;
    void this.recover();
    this.timer = setInterval(() => { void this.recover().catch((error) => console.error("[imageJobs] recovery tick failed", error)); }, this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.jobs.stop();
  }

  private ensure(): Promise<void> {
    return this.schema ??= ensureProductionImageJobSchema(this.db);
  }

  private contextForExisting(job: ImageJob, input: PrepareImageGenerationInput): BindingContext {
    const saved = job.payload.context as Partial<BindingContext> | undefined;
    if (!saved || saved.contractVersion !== 1 || !saved.target || !Number.isInteger(saved.expectedVersion)) throw new ImageGenerationError("CONFLICT", "已有图片任务缺少绑定上下文", 409);
    const expectedTarget = normalizeTarget(input.target, saved.expectedVersion as number);
    if (stableJson(expectedTarget) !== stableJson(saved.target)) throw new ImageGenerationError("CONFLICT", "generationKey 已绑定不同的图片目标或版本", 409);
    if (input.modelKey !== (saved.requestedModelKey ?? job.modelKey)) throw new ImageGenerationError("CONFLICT", "generationKey 已绑定不同的请求图片模型", 409);
    if (stableJson(input.builtinRun ? normalizeBuiltinRun(input.builtinRun) : null) !== stableJson(saved.builtinRun ?? null)) throw new ImageGenerationError("CONFLICT", "generationKey 已绑定不同的内置运行版本", 409);
    return saved as BindingContext;
  }

  private async resolveEffectiveModel(modelKey: string, referenceCount: number): Promise<string> {
    if (!this.options.resolveModel) return modelKey;
    try {
      const resolved = await this.options.resolveModel(modelKey, referenceCount);
      if (typeof resolved !== "string" || !resolved.trim()) throw new Error("图片模型解析器未返回有效模型键");
      return resolved;
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error;
      throw new ImageGenerationError("INVALID_INPUT", error instanceof Error ? error.message : String(error), 400);
    }
  }

  private async readBindingContext(input: PrepareImageGenerationInput): Promise<BindingContext> {
    const target = input.target;
    if (target.kind === "asset") {
      const asset = await this.db("o_assets").where({ id: target.id, projectId: input.projectId }).first();
      if (!asset) throw new ImageGenerationError("NOT_FOUND", "资产不属于当前项目", 404);
      if (target.scriptId != null && !(await this.db("o_scriptAssets").where({ scriptId: target.scriptId, assetId: target.id }).first())) throw new ImageGenerationError("PROJECT_MISMATCH", "资产不属于当前剧集", 400);
      const current = Number(asset.imageId ?? 0);
      if (current && (await this.db("o_image").where({ id: current, assetsId: target.id, state: "生成中" }).first())) throw new ImageGenerationError("CONFLICT", "资产图片正在生成中", 409);
      const expected = target.expectedVersion ?? current;
      if (expected !== current) throw new ImageGenerationError("VERSION_CONFLICT", "资产图片版本已变化", 409);
      return { contractVersion: 1, target: normalizeTarget(target, expected), expectedVersion: expected, targetSignature: assetSignature(asset), previousImageId: asset.imageId == null ? null : Number(asset.imageId) };
    }
    if (target.kind === "storyboard") {
      const row = await this.db("o_storyboard").where({ id: target.id, projectId: input.projectId, scriptId: target.scriptId }).first();
      if (!row) throw new ImageGenerationError("NOT_FOUND", "分镜不属于当前项目或剧集", 404);
      const state = await this.db("ext_entity_state").where({ entityType: "storyboard", entityId: target.id, projectId: input.projectId }).first();
      const current = Number(state?.version ?? 0);
      const expected = target.expectedVersion ?? current;
      if (expected !== current) throw new ImageGenerationError("VERSION_CONFLICT", "分镜版本已变化", 409);
      return { contractVersion: 1, target: normalizeTarget(target, expected), expectedVersion: expected, targetSignature: storyboardSignature(row), previousFilePath: row.filePath ?? null, previousState: row.state ?? null };
    }
    if (!(await this.db("o_project").where({ id: input.projectId }).first())) throw new ImageGenerationError("NOT_FOUND", "项目不存在", 404);
    if (typeof target.id === "number") {
      try {
        const owner = await resolveImageFlowOwner(this.db, target.id);
        if (owner.projectId !== input.projectId || owner.scriptId !== target.scriptId) throw new ImageGenerationError("PROJECT_MISMATCH", "图片工作流不属于当前项目和剧集", 403);
      } catch (error) {
        if (error instanceof ImageFlowWorkspaceError) throw new ImageGenerationError(error.code === "NOT_FOUND" ? "NOT_FOUND" : "PROJECT_MISMATCH", "图片工作流未唯一绑定当前项目和剧集", error.code === "NOT_FOUND" ? 404 : 403);
        throw error;
      }
    }
    const expected = target.expectedVersion ?? 0;
    return { contractVersion: 1, target: normalizeTarget(target, expected), expectedVersion: expected, targetSignature: hash({ projectId: input.projectId, target: normalizeTarget(target, expected) }) };
  }

  private async ensureBinding(job: ImageJob, context: BindingContext): Promise<void> {
    await this.db.transaction(async (trx) => {
      await lockProjectTransaction(trx, job.projectId);
      if (await trx<BindingRow>(BINDINGS).where({ jobId: job.id }).first()) return;
      const target = context.target;
      const now = this.now();
      const base = {
        jobId: job.id, projectId: job.projectId, scriptId: target.scriptId ?? null, targetKind: target.kind,
        targetId: String(target.id), expectedVersion: context.expectedVersion, targetSignature: context.targetSignature,
        previousImageId: context.previousImageId ?? null, previousFilePath: context.previousFilePath ?? null,
        previousState: context.previousState ?? null, runId: context.builtinRun?.id ?? null, runInputRevision: context.builtinRun?.inputRevision ?? null,
        selected: false, state: "RESERVED", createdAt: now, updatedAt: now,
      };
      if (target.kind === "asset") {
        const asset = await trx("o_assets").where({ id: target.id, projectId: job.projectId }).first();
        if (!asset) throw new ImageGenerationError("NOT_FOUND", "资产不属于当前项目", 404);
        if (target.scriptId != null && !(await trx("o_scriptAssets").where({ scriptId: target.scriptId, assetId: target.id }).first())) throw new ImageGenerationError("PROJECT_MISMATCH", "资产不属于当前剧集", 400);
        if (await lockedAssetReference(trx, target.id)) throw new ImageGenerationError("LOCKED", "锁定分镜引用了该资产，不能生成图片", 423);
        if (Number(asset.imageId ?? 0) !== context.expectedVersion || assetSignature(asset) !== context.targetSignature) throw new ImageGenerationError("VERSION_CONFLICT", "资产已被其他操作修改", 409);
        const [candidateImageId] = await insertRowsReturningIds(trx, "o_image", {
          assetsId: target.id, type: asset.type, state: "生成中", model: job.modelKey.split(/:(.+)/)[1] ?? job.modelKey,
          resolution: (job.payload.config as { size?: unknown }).size == null ? null : String((job.payload.config as { size?: unknown }).size),
        });
        if (!context.builtinRun) await trx("o_assets").where({ id: target.id, projectId: job.projectId }).update({ imageId: candidateImageId });
        await trx(BINDINGS).insert({ ...base, candidateImageId, selected: !context.builtinRun });
        return;
      }
      if (target.kind === "storyboard") {
        const row = await trx("o_storyboard").where({ id: target.id, projectId: job.projectId, scriptId: target.scriptId }).first();
        if (!row) throw new ImageGenerationError("NOT_FOUND", "分镜不属于当前项目或剧集", 404);
        await trx("ext_entity_state").insert({ entityType: "storyboard", entityId: target.id, projectId: job.projectId, version: 0, reviewState: "draft", locked: 0 }).onConflict(["entityType", "entityId"]).ignore();
        const state = await trx("ext_entity_state").where({ entityType: "storyboard", entityId: target.id, projectId: job.projectId }).first();
        if (state?.locked) throw new ImageGenerationError("LOCKED", "锁定分镜不能生成图片", 423);
        if (Number(state?.version ?? 0) !== context.expectedVersion || storyboardSignature(row) !== context.targetSignature) throw new ImageGenerationError("VERSION_CONFLICT", "分镜已被其他操作修改", 409);
        if (row.state === "生成中") throw new ImageGenerationError("CONFLICT", "分镜正在生成中", 409);
        const claimToken = `image-job:${job.id}`;
        const claimVersion = context.expectedVersion + 1;
        const claimed = await trx("ext_entity_state").where({ entityType: "storyboard", entityId: target.id, projectId: job.projectId, version: context.expectedVersion }).update({ version: claimVersion, internalMutation: claimToken, updatedAt: now });
        if (claimed !== 1) throw new ImageGenerationError("VERSION_CONFLICT", "分镜已被其他操作修改", 409);
        if (!context.builtinRun) await trx("o_storyboard").where({ id: target.id, projectId: job.projectId, scriptId: target.scriptId }).update({ state: "生成中", shouldGenerateImage: 1 });
        await trx(BINDINGS).insert({ ...base, claimVersion, claimToken, selected: !context.builtinRun });
        return;
      }
      await trx(BINDINGS).insert({ ...base, selected: true });
    });
  }

  private async recordBindingFailure(job: ImageJob, context: BindingContext, error: unknown, forcedState?: "FAILED" | "RECONCILIATION_REQUIRED"): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.db.transaction(async (trx) => {
      await lockProjectTransaction(trx, job.projectId);
      if (await trx<BindingRow>(BINDINGS).where({ jobId: job.id }).first()) return;
      const current = await trx("ext_image_jobs").where({ id: job.id }).first();
      if (!current) return;
      const state = forcedState ?? (current.status === "RESERVED" ? "FAILED" : "RECONCILIATION_REQUIRED");
      await trx("ext_image_jobs").where({ id: job.id }).update({ status: state, lastError: message, nextPollAt: null, updatedAt: this.now() });
      await trx(BINDINGS).insert({
        jobId: job.id, projectId: job.projectId, scriptId: context.target.scriptId ?? null,
        targetKind: context.target.kind, targetId: String(context.target.id), expectedVersion: context.expectedVersion,
        claimVersion: null, claimToken: null, targetSignature: context.targetSignature,
        previousImageId: context.previousImageId ?? null, previousFilePath: context.previousFilePath ?? null,
        previousState: context.previousState ?? null, runId: context.builtinRun?.id ?? null,
        runInputRevision: context.builtinRun?.inputRevision ?? null, candidateImageId: null, artifactPath: null,
        selected: false, state, error: message, createdAt: this.now(), updatedAt: this.now(),
      });
    });
  }

  private async bindSavedArtifact(job: ImageJob, trx: Knex.Transaction): Promise<void> {
    let binding = await trx<BindingRow>(BINDINGS).where({ jobId: job.id, projectId: job.projectId }).first();
    if (!binding) throw new ImageGenerationError("NOT_FOUND", "图片任务缺少目标绑定", 409);
    // Builtin commits lock run before project. Keep the same order so a pause,
    // takeover, or executor commit cannot deadlock with a late media callback.
    const runMaySelect = await this.runMayAutoSelect(trx, binding);
    await lockProjectTransaction(trx, job.projectId);
    const jobRowQuery = trx("ext_image_jobs").where({ id: job.id });
    if (isPostgres(trx)) jobRowQuery.forUpdate();
    const currentJob = await jobRowQuery.first();
    if (!currentJob || currentJob.status !== "DOWNLOADING") return;
    binding = await trx<BindingRow>(BINDINGS).where({ jobId: job.id, projectId: job.projectId }).first();
    if (!binding) throw new ImageGenerationError("NOT_FOUND", "图片任务缺少目标绑定", 409);
    let selected = false;
    if (binding.targetKind === "asset") {
      const candidateImageId = Number(binding.candidateImageId);
      await trx("o_image").where({ id: candidateImageId, assetsId: Number(binding.targetId) }).update({ filePath: job.outputPath, state: "已完成", errorReason: null });
      const asset = await trx("o_assets").where({ id: Number(binding.targetId), projectId: job.projectId }).first();
      const pointerIsExpected = asset && (Number(asset.imageId) === candidateImageId || (binding.runId && Number(asset.imageId ?? 0) === Number(binding.previousImageId ?? 0)));
      selected = Boolean(runMaySelect && pointerIsExpected && assetSignature(asset) === binding.targetSignature && !(await lockedAssetReference(trx, Number(binding.targetId))));
      if (selected && asset && Number(asset.imageId) !== candidateImageId) await trx("o_assets").where({ id: asset.id, projectId: job.projectId, imageId: binding.previousImageId ?? null }).update({ imageId: candidateImageId });
      if (!selected && asset && Number(asset.imageId) === candidateImageId) {
        await trx("o_assets").where({ id: asset.id, projectId: job.projectId, imageId: candidateImageId }).update({ imageId: binding.previousImageId == null ? null : Number(binding.previousImageId) });
      }
    } else if (binding.targetKind === "storyboard") {
      const id = Number(binding.targetId);
      const row = await trx("o_storyboard").where({ id, projectId: job.projectId, scriptId: binding.scriptId }).first();
      const state = await trx("ext_entity_state").where({ entityType: "storyboard", entityId: id, projectId: job.projectId }).first();
      selected = Boolean(runMaySelect && row && state && !state.locked && Number(state.version) === Number(binding.claimVersion) && state.internalMutation === binding.claimToken && storyboardSignature({ ...row, state: binding.previousState, filePath: binding.previousFilePath }) === binding.targetSignature);
      if (selected) {
        await trx("o_storyboard").where({ id, projectId: job.projectId, scriptId: binding.scriptId }).update({ filePath: job.outputPath, state: "已完成", reason: null });
        await trx("ext_entity_state").where({ entityType: "storyboard", entityId: id, projectId: job.projectId, version: binding.claimVersion, internalMutation: binding.claimToken }).update({ version: Number(binding.claimVersion) + 1, internalMutation: null, updatedAt: this.now() });
      } else if (state?.internalMutation === binding.claimToken) {
        if (row?.state === "生成中" && row.filePath === binding.previousFilePath) await trx("o_storyboard").where({ id, projectId: job.projectId }).update({ state: binding.previousState });
        await trx("ext_entity_state").where({ entityType: "storyboard", entityId: id, projectId: job.projectId, internalMutation: binding.claimToken }).update({ version: Number(state.version) + 1, internalMutation: null, updatedAt: this.now() });
      } else if (row?.state === "生成中" && row.filePath === binding.previousFilePath && state && state.internalMutation == null) {
        const releaseToken = `image-release:${job.id}`;
        const reserved = await trx("ext_entity_state").where({ entityType: "storyboard", entityId: id, projectId: job.projectId, version: state.version }).update({ version: Number(state.version) + 1, internalMutation: releaseToken, updatedAt: this.now() });
        if (reserved === 1) {
          await trx("o_storyboard").where({ id, projectId: job.projectId, state: "生成中", filePath: binding.previousFilePath }).update({ state: binding.previousState });
          await trx("ext_entity_state").where({ entityType: "storyboard", entityId: id, projectId: job.projectId, internalMutation: releaseToken }).update({ internalMutation: null });
        }
      }
    } else {
      selected = runMaySelect;
    }
    await trx(BINDINGS).where({ jobId: job.id }).update({ artifactPath: job.outputPath, selected, state: "SUCCEEDED", error: null, updatedAt: this.now() });
  }

  private async syncTerminal(job: ImageJob): Promise<void> {
    if (job.status === "SUCCEEDED") return;
    if (job.status !== "FAILED" && job.status !== "RECONCILIATION_REQUIRED") return;
    await this.db.transaction(async (trx) => {
      await lockProjectTransaction(trx, job.projectId);
      const binding = await trx<BindingRow>(BINDINGS).where({ jobId: job.id }).first();
      if (!binding || binding.state === job.status) return;
      if (binding.targetKind === "asset" && binding.candidateImageId != null) {
        const candidate = Number(binding.candidateImageId);
        await trx("o_image").where({ id: candidate, assetsId: Number(binding.targetId) }).update({ state: "生成失败", errorReason: job.lastError });
        await trx("o_assets").where({ id: Number(binding.targetId), projectId: job.projectId, imageId: candidate }).update({ imageId: binding.previousImageId == null ? null : Number(binding.previousImageId) });
      } else if (binding.targetKind === "storyboard") {
        const id = Number(binding.targetId);
        const state = await trx("ext_entity_state").where({ entityType: "storyboard", entityId: id, projectId: job.projectId }).first();
        if (state?.internalMutation === binding.claimToken && Number(state.version) === Number(binding.claimVersion)) {
          await trx("o_storyboard").where({ id, projectId: job.projectId, state: "生成中" }).update({ state: "生成失败", reason: job.lastError });
          await trx("ext_entity_state").where({ entityType: "storyboard", entityId: id, projectId: job.projectId, internalMutation: binding.claimToken }).update({ version: Number(state.version) + 1, internalMutation: null, updatedAt: this.now() });
        } else if (state && state.internalMutation == null) {
          const row = await trx("o_storyboard").where({ id, projectId: job.projectId }).first();
          if (row?.state === "生成中" && row.filePath === binding.previousFilePath) {
            const releaseToken = `image-failure-release:${job.id}`;
            const reserved = await trx("ext_entity_state").where({ entityType: "storyboard", entityId: id, projectId: job.projectId, version: state.version }).update({ version: Number(state.version) + 1, internalMutation: releaseToken, updatedAt: this.now() });
            if (reserved === 1) {
              await trx("o_storyboard").where({ id, projectId: job.projectId, state: "生成中", filePath: binding.previousFilePath }).update({ state: binding.previousState, reason: job.lastError });
              await trx("ext_entity_state").where({ entityType: "storyboard", entityId: id, projectId: job.projectId, internalMutation: releaseToken }).update({ internalMutation: null });
            }
          }
        }
      }
      await trx(BINDINGS).where({ jobId: job.id }).update({ selected: false, state: job.status, error: job.lastError, updatedAt: this.now() });
    });
  }

  private async runMayAutoSelect(trx: Knex.Transaction, binding: BindingRow): Promise<boolean> {
    if (!binding.runId) return true;
    const runQuery = trx("ext_builtin_runs").where({ id: binding.runId, projectId: binding.projectId }).select("status", "inputRevision", "requestedBy", "executionUserId");
    if (isPostgres(trx)) runQuery.forUpdate();
    const run = await runQuery.first();
    if (!run || run.status !== "running" || Number(run.inputRevision) !== Number(binding.runInputRevision)) return false;
    if (!(await trx.schema.hasTable("team_users"))) return true;
    const executionUserId = run.executionUserId ?? run.requestedBy;
    const ownerQuery = trx("team_users").where({ user_id: executionUserId }).select("enabled", "role");
    if (isPostgres(trx)) ownerQuery.forUpdate();
    const owner = await ownerQuery.first();
    return Boolean(owner && (owner.enabled === true || owner.enabled === 1 || owner.enabled === "t") && (owner.role === "admin" || owner.role === "editor"));
  }

  private async receipt(job: ImageJob): Promise<ImageGenerationReceipt> {
    const binding = await this.db<BindingRow>(BINDINGS).where({ jobId: job.id }).first();
    if (!binding) throw new ImageGenerationError("NOT_FOUND", "图片任务缺少目标绑定", 409);
    const target = (job.payload.context as BindingContext).target;
    let selected = Boolean(binding.selected);
    if (job.status === "SUCCEEDED" && binding.artifactPath && binding.targetKind === "asset") {
      const current = await this.db("o_assets as asset").join("o_image as image", "image.id", "asset.imageId")
        .where({ "asset.id": Number(binding.targetId), "asset.projectId": job.projectId }).select("image.filePath").first();
      selected = Boolean(current?.filePath && canonicalMediaPath(current.filePath) === canonicalMediaPath(binding.artifactPath));
    } else if (job.status === "SUCCEEDED" && binding.artifactPath && binding.targetKind === "storyboard") {
      const current = await this.db("o_storyboard").where({ id: Number(binding.targetId), projectId: job.projectId, scriptId: binding.scriptId }).first();
      selected = Boolean(current?.filePath && canonicalMediaPath(current.filePath) === canonicalMediaPath(binding.artifactPath));
    }
    const result: ImageGenerationReceipt = {
      jobId: job.id, generationKey: job.idempotencyKey, projectId: job.projectId, target,
      status: mapStatus(job.status), selected,
    };
    if (job.upstreamTaskId) result.upstreamTaskId = job.upstreamTaskId;
    if (binding.artifactPath) result.artifactPath = binding.artifactPath;
    if (job.lastError) result.error = job.lastError;
    return result;
  }

  private defaultOutputPath(input: PrepareImageGenerationInput): string {
    const suffix = `${this.options.uuid?.() ?? cryptoRandom()}.jpg`;
    if (input.target.kind === "flow") return `/${input.projectId}/workFlow/${suffix}`;
    if (input.target.kind === "storyboard") return `/${input.projectId}/assets/${input.target.scriptId}/${suffix}`;
    return input.target.scriptId == null ? `/${input.projectId}/assets/${suffix}` : `/${input.projectId}/assets/${input.target.scriptId}/${suffix}`;
  }

  private assertPrepareInput(input: PrepareImageGenerationInput): void {
    if (!Number.isSafeInteger(input.projectId) || input.projectId <= 0) throw new ImageGenerationError("INVALID_INPUT", "projectId 必须是正整数");
    if (!input.generationKey || input.generationKey.length < 8 || input.generationKey.length > 200) throw new ImageGenerationError("INVALID_INPUT", "generationKey 不合法");
    if (!input.modelKey || !input.config?.prompt || !input.config.size || !input.config.aspectRatio) throw new ImageGenerationError("INVALID_INPUT", "图片生成参数不完整");
    for (const reference of input.config.referenceList ?? []) {
      if (reference?.type !== "image" || typeof reference.base64 !== "string" || !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(reference.base64)) {
        throw new ImageGenerationError("INVALID_INPUT", "图片参考包含非图片媒体或无效数据");
      }
    }
    if ((input.target.kind === "asset" || input.target.kind === "storyboard") && (!Number.isSafeInteger(input.target.id) || input.target.id <= 0)) throw new ImageGenerationError("INVALID_INPUT", "图片目标 ID 不合法");
    if (input.outputPath) canonicalMediaPath(input.outputPath);
    if (input.builtinRun) normalizeBuiltinRun(input.builtinRun);
  }
}

export function createImageGenerationService(options: ImageGenerationServiceOptions): ImageGenerationService {
  return new ImageGenerationService(options);
}

function normalizeTarget(target: ImageGenerationTarget, expectedVersion: number): ImageGenerationTarget {
  return { ...target, expectedVersion } as ImageGenerationTarget;
}

function normalizeBuiltinRun(value: { id: string; inputRevision: number }): { id: string; inputRevision: number } {
  if (!value || typeof value.id !== "string" || !/^[0-9a-f-]{16,64}$/i.test(value.id) || !Number.isInteger(value.inputRevision) || value.inputRevision < 0) {
    throw new ImageGenerationError("INVALID_INPUT", "内置运行图片绑定无效");
  }
  return { id: value.id, inputRevision: value.inputRevision };
}

function normalizeConfig(config: PrepareImageGenerationInput["config"]): PrepareImageGenerationInput["config"] {
  return { prompt: config.prompt, referenceList: config.referenceList ?? [], size: config.size, aspectRatio: config.aspectRatio };
}

function assetSignature(asset: Record<string, unknown>): string {
  return hash({ id: Number(asset.id), projectId: Number(asset.projectId), assetsId: asset.assetsId == null ? null : Number(asset.assetsId), type: asset.type ?? null, name: asset.name ?? null, describe: asset.describe ?? null, prompt: asset.prompt ?? null });
}

function storyboardSignature(row: Record<string, unknown>): string {
  return hash({ id: Number(row.id), projectId: Number(row.projectId), scriptId: Number(row.scriptId), prompt: row.prompt ?? null, videoDesc: row.videoDesc ?? null, shouldGenerateImage: row.shouldGenerateImage ?? null, filePath: row.filePath ?? null, state: row.state ?? null });
}

async function lockedAssetReference(trx: Knex.Transaction, assetId: number): Promise<boolean> {
  const row = await trx("o_assets2Storyboard as relation")
    .join("ext_entity_state as state", function () {
      this.on("state.entityType", "=", trx.raw("?", ["storyboard"]))
        .andOn("state.entityId", "=", "relation.storyboardId")
        .andOn("state.locked", "=", trx.raw("?", [1]));
    })
    .where("relation.assetId", assetId).first();
  return Boolean(row);
}

function mapStatus(status: ImageJob["status"]): ImageGenerationStatus {
  if (status === "SUCCEEDED") return "succeeded";
  if (status === "FAILED") return "failed";
  if (status === "RECONCILIATION_REQUIRED") return "needs_reconciliation";
  return "pending";
}

function terminal(status: ImageJob["status"]): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "RECONCILIATION_REQUIRED";
}

function canonicalMediaPath(value: string): string {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)) throw new ImageGenerationError("INVALID_INPUT", "图片路径无效");
  let path = value.split("?")[0];
  if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  if (path === "/oss" || path.startsWith("/oss/")) path = path.slice(4);
  const relative = path.replace(/^\/+/, "");
  if (!relative || relative.includes("//") || relative.split("/").some((part) => part === "." || part === "..")) throw new ImageGenerationError("INVALID_INPUT", "图片路径无效");
  return `/${relative}`;
}

function mediaPathAliases(value: string): string[] {
  const canonical = canonicalMediaPath(value);
  return [canonical, canonical.slice(1)];
}

function hash(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener("abort", done); clearTimeout(timer); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}
function cryptoRandom(): string { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
export function imageGenerationErrorStatus(error: unknown): number {
  if (error instanceof ImageGenerationError) return error.status;
  if (error instanceof ImageJobError) return error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400;
  return 400;
}
