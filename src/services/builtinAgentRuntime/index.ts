import crypto from "node:crypto";
import type { Knex } from "knex";
import { lockProjectTransaction } from "../../lib/dbTransaction";
import { StructuredModelOutputError } from "../../lib/structuredModelOutput";
import {
  defaultBuiltinRunLimits,
  type BuiltinAgentType,
  type BuiltinControlAction,
  type BuiltinRunEvent,
  type BuiltinRunLimits,
  type BuiltinRunStatus,
  type BuiltinRunView,
  type CreateBuiltinRun,
  hasUnlimitedMediaBudget,
  hasIndependentProductionOutput,
} from "../builtinAgent/contracts";

const RUNS = "ext_builtin_runs";
const STEPS = "ext_builtin_run_steps";
const EVENTS = "ext_builtin_run_events";
const TERMINAL = new Set<BuiltinRunStatus>(["succeeded", "failed", "reconciliation_required", "cancelled"]);

export type BuiltinRuntimeErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STALE_VERSION"
  | "FORBIDDEN"
  | "LEASE_LOST"
  | "PAUSED"
  | "CANCELLED"
  | "WAITING_HUMAN"
  | "BUDGET_EXCEEDED"
  | "RECONCILIATION_REQUIRED";

export class BuiltinRuntimeError extends Error {
  readonly code: BuiltinRuntimeErrorCode;

  constructor(code: BuiltinRuntimeErrorCode, message: string) {
    super(message);
    this.name = "BuiltinRuntimeError";
    this.code = code;
  }
}

export interface BuiltinStepOptions {
  modelCall?: boolean;
  sideEffect?: boolean;
  imageGeneration?: boolean;
  videoGeneration?: boolean;
}

export interface BuiltinExecutionContext {
  readonly run: BuiltinRunView;
  readonly signal: AbortSignal;
  emit(type: string, data: unknown): Promise<BuiltinRunEvent>;
  assertActive(): Promise<void>;
  remainingOutputTokens?(): Promise<number>;
  waitForHuman(question: string, data?: unknown): Promise<void>;
  step<T>(
    key: string,
    input: unknown,
    perform: () => Promise<T> | T,
    options?: BuiltinStepOptions,
  ): Promise<T>;
  commit<T>(
    key: string,
    input: unknown,
    perform: (trx: Knex.Transaction) => Promise<T>,
  ): Promise<T>;
}

/** Alias used by executors that call the context a runtime context. */
export type BuiltinRuntimeContext = BuiltinExecutionContext;

export interface BuiltinAgentRuntimeOptions {
  db: Knex;
  execute(context: BuiltinExecutionContext): Promise<unknown>;
  authorize(run: BuiltinRunView, transaction?: Knex.Transaction): Promise<void>;
  beforeCreate?(run: BuiltinRunView, transaction: Knex.Transaction): Promise<void>;
  now?: () => number;
  pollMs?: number;
  leaseMs?: number;
  workerId?: string;
  maxConcurrentRuns?: number;
}

interface RuntimeRunExtensions {
  inputRevision: number;
  continuation: string;
}

type RunRow = {
  id: string;
  agentType: BuiltinAgentType;
  projectId: number | null;
  scriptId: number | null;
  requestedBy: number;
  executionUserId?: number | null;
  prompt: string;
  idempotencyKey: string;
  requestHash: string;
  status: BuiltinRunStatus;
  version: number | string;
  lastSequence: number | string;
  currentStep: string | null;
  limits: BuiltinRunLimits | string;
  modelCalls: number | string;
  toolSteps: number | string;
  outputTokens: number | string;
  imageGenerations: number | string;
  videoGenerations: number | string;
  leaseOwner: string | null;
  leaseEpoch: number | string;
  leaseUntil: number | string | null;
  waitingQuestion?: string | null;
  waitingData?: unknown;
  createdAt: number | string;
  updatedAt: number | string;
  inputRevision?: number | string;
  continuation?: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  result: unknown;
  intent?: unknown;
};

type StepRow = {
  runId: string;
  stepKey: string;
  inputHash: string;
  input: unknown;
  status: "started" | "completed" | "uncertain";
  result: unknown;
  sideEffect: boolean;
  modelCall: boolean;
  imageGeneration: boolean;
  videoGeneration: boolean;
  outputTokens: number | string;
  attempt: number | string;
  startedEpoch: number | string | null;
  startedOwner: string | null;
};

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  // JSONB should never receive an undefined value. This also makes errors from
  // circular values explicit at the call site instead of being silently lost.
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as T;
  try { return JSON.parse(value) as T; } catch { return value as T; }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function hashInput(value: unknown): string {
  // Hash the JSON representation that will actually survive a checkpoint.
  // Optional undefined fields disappear from objects when stored in JSONB.
  const persisted = parseJson(jsonValue(value));
  return crypto.createHash("sha256").update(canonical(persisted)).digest("hex");
}

function int(value: number | string | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function limitsOf(value: BuiltinRunLimits | string): BuiltinRunLimits {
  const parsed = parseJson<BuiltinRunLimits>(value);
  if (!parsed) throw new BuiltinRuntimeError("CONFLICT", "Run limits are missing");
  return parsed;
}

function estimateOutputTokens(value: unknown): number {
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    for (const key of ["outputTokens", "usageOutputTokens", "completionTokens"]) {
      if (typeof candidate[key] === "number" && Number.isFinite(candidate[key])) return Math.max(0, Math.ceil(candidate[key] as number));
    }
  }
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return Math.ceil(text.length / 4);
}

function isPg(db: Knex): boolean {
  return String(db.client.config.client).startsWith("pg");
}

export async function ensureBuiltinAgentRuntimeSchema(db: Knex): Promise<void> {
  if (!isPg(db)) throw new Error("Builtin agent runtime requires PostgreSQL");
  await db.transaction(async (trx) => {
    await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["toonflow:builtin-agent-runtime-schema"]);
    if (!(await trx.schema.hasTable(RUNS))) {
      await trx.schema.createTable(RUNS, (table) => {
        table.uuid("id").primary();
        table.text("agentType").notNullable();
        table.integer("projectId").nullable();
        table.integer("scriptId").nullable();
        table.integer("requestedBy").notNullable();
        table.text("prompt").notNullable();
        table.text("idempotencyKey").notNullable();
        table.text("requestHash").notNullable();
        table.text("status").notNullable();
        table.integer("version").notNullable().defaultTo(0);
        table.integer("lastSequence").notNullable().defaultTo(0);
        table.text("currentStep").nullable();
        table.jsonb("limits").notNullable();
        table.integer("modelCalls").notNullable().defaultTo(0);
        table.integer("toolSteps").notNullable().defaultTo(0);
        table.integer("outputTokens").notNullable().defaultTo(0);
        table.integer("imageGenerations").notNullable().defaultTo(0);
        table.integer("videoGenerations").notNullable().defaultTo(0);
        table.text("leaseOwner").nullable();
        table.bigInteger("leaseEpoch").notNullable().defaultTo(0);
        table.bigInteger("leaseUntil").nullable();
        table.bigInteger("createdAt").notNullable();
        table.bigInteger("updatedAt").notNullable();
        table.text("errorCode").nullable();
        table.text("errorMessage").nullable();
        table.text("waitingQuestion").nullable();
        table.jsonb("waitingData").nullable();
        table.integer("inputRevision").notNullable().defaultTo(0);
        table.text("continuation").notNullable().defaultTo("");
        table.jsonb("result").nullable();
        table.unique(["requestedBy", "idempotencyKey"]);
        table.index(["status", "leaseUntil"]);
        table.index(["projectId", "scriptId", "createdAt"]);
      });
    }
    if (!(await trx.schema.hasTable(STEPS))) {
      await trx.schema.createTable(STEPS, (table) => {
        table.uuid("runId").notNullable();
        table.text("stepKey").notNullable();
        table.text("inputHash").notNullable();
        table.jsonb("input").notNullable();
        table.text("status").notNullable();
        table.jsonb("result").nullable();
        table.boolean("sideEffect").notNullable().defaultTo(false);
        table.boolean("modelCall").notNullable().defaultTo(false);
        table.boolean("imageGeneration").notNullable().defaultTo(false);
        table.boolean("videoGeneration").notNullable().defaultTo(false);
        table.integer("outputTokens").notNullable().defaultTo(0);
        table.integer("attempt").notNullable().defaultTo(1);
        table.bigInteger("startedEpoch").nullable();
        table.text("startedOwner").nullable();
        table.bigInteger("startedAt").notNullable();
        table.bigInteger("completedAt").nullable();
        table.bigInteger("updatedAt").notNullable();
        table.primary(["runId", "stepKey"]);
        table.index(["runId", "status"]);
      });
    }
    if (await trx.schema.hasTable(RUNS)) {
      if (!(await trx.schema.hasColumn(RUNS, "waitingQuestion"))) await trx.schema.alterTable(RUNS, (table) => table.text("waitingQuestion").nullable());
      if (!(await trx.schema.hasColumn(RUNS, "waitingData"))) await trx.schema.alterTable(RUNS, (table) => table.jsonb("waitingData").nullable());
      if (!(await trx.schema.hasColumn(RUNS, "inputRevision"))) await trx.schema.alterTable(RUNS, (table) => table.integer("inputRevision").notNullable().defaultTo(0));
      if (!(await trx.schema.hasColumn(RUNS, "continuation"))) await trx.schema.alterTable(RUNS, (table) => table.text("continuation").notNullable().defaultTo(""));
      if (!(await trx.schema.hasColumn(RUNS, "executionUserId"))) await trx.schema.alterTable(RUNS, (table) => table.integer("executionUserId").nullable());
      if (!(await trx.schema.hasColumn(RUNS, "intent"))) await trx.schema.alterTable(RUNS, (table) => table.jsonb("intent").nullable());
    }
    if (await trx.schema.hasTable(STEPS)) {
      if (!(await trx.schema.hasColumn(STEPS, "startedEpoch"))) await trx.schema.alterTable(STEPS, (table) => table.bigInteger("startedEpoch").nullable());
      if (!(await trx.schema.hasColumn(STEPS, "startedOwner"))) await trx.schema.alterTable(STEPS, (table) => table.text("startedOwner").nullable());
    }
    if (!(await trx.schema.hasTable(EVENTS))) {
      await trx.schema.createTable(EVENTS, (table) => {
        table.uuid("runId").notNullable();
        table.integer("sequence").notNullable();
        table.text("type").notNullable();
        table.jsonb("data").notNullable();
        table.bigInteger("createdAt").notNullable();
        table.primary(["runId", "sequence"]);
        table.index(["runId", "sequence"]);
      });
    }
  });
}

export class BuiltinAgentRuntime {
  private readonly db: Knex;
  private readonly executeFn: BuiltinAgentRuntimeOptions["execute"];
  private readonly authorizeFn: BuiltinAgentRuntimeOptions["authorize"];
  private readonly beforeCreate?: BuiltinAgentRuntimeOptions["beforeCreate"];
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly workerId: string;
  private readonly maxConcurrentRuns: number;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private claiming = 0;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void>; epoch: number }>();

  constructor(options: BuiltinAgentRuntimeOptions) {
    this.db = options.db;
    this.executeFn = options.execute;
    this.authorizeFn = options.authorize;
    this.beforeCreate = options.beforeCreate;
    this.now = options.now ?? (() => Date.now());
    this.pollMs = Math.max(10, options.pollMs ?? 250);
    this.leaseMs = Math.max(100, options.leaseMs ?? 30_000);
    this.workerId = options.workerId ?? `builtin-${crypto.randomUUID()}`;
    this.maxConcurrentRuns = Math.max(1, Math.floor(options.maxConcurrentRuns ?? 2));
  }

  async create(input: CreateBuiltinRun): Promise<{ run: BuiltinRunView; reused: boolean }> {
    this.validateCreate(input);
    const id = crypto.randomUUID();
    const now = this.now();
    const limits = this.normalizeLimits(input.limits);
    const requestHash = hashInput({
      agentType: input.agentType,
      projectId: input.projectId ?? null,
      scriptId: input.scriptId ?? null,
      requestedBy: input.requestedBy,
      prompt: input.prompt,
      limits,
      ...(input.intent == null ? {} : { intent: input.intent }),
    });
    const candidate = this.toView({
      id,
      agentType: input.agentType,
      projectId: input.projectId ?? null,
      scriptId: input.scriptId ?? null,
      requestedBy: input.requestedBy,
      prompt: input.prompt,
      status: "queued",
      version: 0,
      lastSequence: 1,
      currentStep: null,
      limits,
      modelCalls: 0,
      toolSteps: 0,
      outputTokens: 0,
      imageGenerations: 0,
      videoGenerations: 0,
      leaseEpoch: 0,
      createdAt: now,
      updatedAt: now,
      errorCode: null,
      errorMessage: null,
      inputRevision: 0,
      continuation: "",
      intent: jsonValue(input.intent),
      result: null,
    } as RunRow);
    const existingBeforeAuthorization = await this.db<RunRow>(RUNS).where({ requestedBy: input.requestedBy, idempotencyKey: input.idempotencyKey }).first();
    if (existingBeforeAuthorization) {
      if (existingBeforeAuthorization.requestHash !== requestHash) throw new BuiltinRuntimeError("CONFLICT", "idempotencyKey 已用于不同的运行参数");
      await this.authorizeFn(this.toView(existingBeforeAuthorization));
      return { run: this.toView(existingBeforeAuthorization), reused: true };
    }
    await this.authorizeFn(candidate);
    const inserted = await this.db.transaction(async (trx) => {
      await this.authorizeFn(candidate, trx);
      if (input.projectId != null) await lockProjectTransaction(trx, input.projectId);
      const existing = await trx<RunRow>(RUNS)
        .where({ requestedBy: input.requestedBy, idempotencyKey: input.idempotencyKey })
        .first();
      if (existing) {
        if (existing.requestHash !== requestHash) throw new BuiltinRuntimeError("CONFLICT", "idempotencyKey 已用于不同的运行参数");
        return { row: existing, reused: true };
      }
      const row: Record<string, unknown> = {
        id,
        agentType: input.agentType,
        projectId: input.projectId ?? null,
        scriptId: input.scriptId ?? null,
        requestedBy: input.requestedBy,
        prompt: input.prompt,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        status: "queued",
        version: 0,
        lastSequence: 1,
        currentStep: null,
        limits: jsonValue(limits),
        modelCalls: 0,
        toolSteps: 0,
        outputTokens: 0,
        imageGenerations: 0,
        videoGenerations: 0,
        leaseEpoch: 0,
        leaseUntil: null,
        createdAt: now,
        updatedAt: now,
        errorCode: null,
        errorMessage: null,
        inputRevision: 0,
        continuation: "",
        result: null,
        intent: jsonValue(input.intent),
      };
      await this.beforeCreate?.(candidate, trx);
      const insertedRows = await trx(RUNS).insert(row).onConflict(["requestedBy", "idempotencyKey"]).ignore().returning("id");
      if (!Array.isArray(insertedRows) || insertedRows.length === 0) {
        const raced = await trx<RunRow>(RUNS).where({ requestedBy: input.requestedBy, idempotencyKey: input.idempotencyKey }).first();
        if (!raced) throw new BuiltinRuntimeError("CONFLICT", "Idempotent run disappeared during creation");
        if (raced.requestHash !== requestHash) throw new BuiltinRuntimeError("CONFLICT", "idempotencyKey 已用于不同的运行参数");
        return { row: raced, reused: true };
      }
      await trx(EVENTS).insert({ runId: id, sequence: 1, type: "run.created", data: jsonValue({ status: "queued" }), createdAt: now });
      return { row: row as RunRow, reused: false };
    });
    if (inserted.reused) await this.authorizeFn(this.toView(inserted.row));
    return { run: this.toView(inserted.row), reused: inserted.reused };
  }

  async get(runId: string): Promise<BuiltinRunView> {
    const row = await this.db<RunRow>(RUNS).where({ id: runId }).first();
    if (!row) throw new BuiltinRuntimeError("NOT_FOUND", "Builtin run not found");
    return this.toView(row);
  }

  async findByIdempotency(requestedBy: number, idempotencyKey: string): Promise<BuiltinRunView | undefined> {
    const row = await this.db<RunRow>(RUNS).where({ requestedBy, idempotencyKey }).first();
    if (!row) return undefined;
    const run = this.toView(row);
    await this.authorizeFn(run);
    return run;
  }

  async list(input: { projectId: number; scriptId?: number | null; limit?: number }): Promise<BuiltinRunView[]> {
    const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
    let query = this.db<RunRow>(RUNS).where({ projectId: input.projectId });
    if (input.scriptId !== undefined) query = query.where({ scriptId: input.scriptId });
    const rows = await query.orderBy("createdAt", "desc").limit(limit);
    return rows.map((row) => this.toView(row));
  }

  async events(runId: string, afterSequence = 0, limit = 500): Promise<BuiltinRunEvent[]> {
    await this.get(runId);
    const rows = await this.db(EVENTS).where({ runId }).andWhere("sequence", ">", Math.max(0, afterSequence)).orderBy("sequence", "asc").limit(Math.min(500, Math.max(1, limit)));
    return rows.map((row) => ({ runId: String(row.runId), sequence: Number(row.sequence), type: String(row.type), data: parseJson(row.data) ?? null, createdAt: Number(row.createdAt) }));
  }

  async control(runId: string, expectedVersion: number, action: BuiltinControlAction, reason?: string, actorId?: number | string): Promise<BuiltinRunView> {
    const current = await this.get(runId);
    if (current.version !== expectedVersion) throw new BuiltinRuntimeError("STALE_VERSION", "Run version is stale");
    const controllerId = actorId == null ? current.executionUserId ?? current.requestedBy : Number(actorId);
    if (!Number.isSafeInteger(controllerId) || controllerId <= 0) throw new BuiltinRuntimeError("FORBIDDEN", "控制者身份无效");
    await this.authorizeFn({ ...current, requestedBy: controllerId, executionUserId: controllerId });
    const now = this.now();
    const result = await this.db.transaction(async (trx) => {
      const row = await trx<RunRow>(RUNS).where({ id: runId }).forUpdate().first();
      if (!row) throw new BuiltinRuntimeError("NOT_FOUND", "Builtin run not found");
      if (int(row.version) !== expectedVersion) throw new BuiltinRuntimeError("STALE_VERSION", "Run version is stale");
      await this.authorizeFn({ ...this.toView(row), requestedBy: controllerId, executionUserId: controllerId }, trx);
      const status = row.status;
      if (TERMINAL.has(status)) throw new BuiltinRuntimeError("CONFLICT", "Run is already terminal");
      let next: BuiltinRunStatus;
      switch (action) {
        case "pause":
          if (status !== "queued" && status !== "running" && status !== "waiting_human") throw new BuiltinRuntimeError("CONFLICT", "Run cannot be paused");
          next = "paused";
          break;
        case "resume":
          if (status !== "paused" && status !== "waiting_human") throw new BuiltinRuntimeError("CONFLICT", "Only paused or waiting runs can resume");
          next = "queued";
          break;
        case "cancel":
          next = "cancelled";
          break;
        case "takeover":
          if (status !== "running" && status !== "queued" && status !== "waiting_human" && status !== "paused") throw new BuiltinRuntimeError("CONFLICT", "Run cannot be taken over");
          next = "paused";
          break;
      }
      const version = int(row.version) + 1;
      const epoch = int(row.leaseEpoch) + 1;
      const resumeFromHuman = action === "resume" && status === "waiting_human";
      const inputRevision = resumeFromHuman || action === "takeover" ? int(row.inputRevision) + 1 : int(row.inputRevision);
      const continuation = resumeFromHuman ? appendContinuation(row.continuation ?? "", reason) : (row.continuation ?? "");
      await trx(RUNS).where({ id: runId, version: expectedVersion }).update({
        status: next,
        version,
        leaseEpoch: epoch,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: now,
        currentStep: next === "queued" || next === "paused" ? row.currentStep : row.currentStep,
        inputRevision,
        continuation,
        executionUserId: action === "resume" || action === "takeover" ? controllerId : row.executionUserId,
      });
      await this.insertEvent(trx, runId, int(row.lastSequence) + 1, "run.status", { status: next, action, reason: reason ?? null, actorId: actorId ?? null }, now, version);
      return await trx<RunRow>(RUNS).where({ id: runId }).first() as RunRow;
    });
    if (action === "pause" || action === "cancel" || action === "takeover") this.active.get(runId)?.controller.abort();
    return this.toView(result);
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => undefined);
    }, this.pollMs);
    this.timer.unref?.();
    void this.runOnce().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const item of this.active.values()) item.controller.abort();
    await Promise.allSettled([...this.active.entries()].map(([runId, item]) => this.releaseAfterStop(runId, item.epoch)));
    const pending = Promise.allSettled([...this.active.values()].map((item) => item.promise));
    await Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
  }

  async runOnce(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.active.size + this.claiming >= this.maxConcurrentRuns) return false;
    this.claiming += 1;
    let claimed: { run: BuiltinRunView; epoch: number } | null;
    try {
      claimed = await this.claim();
    } finally {
      this.claiming -= 1;
    }
    if (!claimed) return false;
    const controller = new AbortController();
    const promise = this.executeClaimed(claimed, controller);
    this.active.set(claimed.run.id, { controller, promise, epoch: claimed.epoch });
    try {
      await promise;
    } finally {
      this.active.delete(claimed.run.id);
    }
    return true;
  }

  private async claim(): Promise<{ run: BuiltinRunView; epoch: number }> {
    const now = this.now();
    return this.db.transaction(async (trx) => {
      const row = await trx<RunRow>(RUNS)
        .where((builder) => builder.where("status", "queued").orWhere((inner) => inner.where("status", "running").andWhere((nested) => nested.whereNull("leaseUntil").orWhere("leaseUntil", "<", now))))
        .orderBy("createdAt", "asc")
        .forUpdate()
        .skipLocked()
        .first();
      if (!row) return null as never;
      const staleSideEffect = await trx<StepRow>(STEPS).where({ runId: row.id, status: "started", sideEffect: true }).first();
      if (staleSideEffect) {
        const epoch = int(row.leaseEpoch) + 1;
        const version = int(row.version) + 1;
        await trx(RUNS).where({ id: row.id }).update({ status: "reconciliation_required", version, leaseEpoch: epoch, leaseOwner: null, leaseUntil: null, errorCode: "RECONCILIATION_REQUIRED", errorMessage: `未确认的副作用步骤: ${staleSideEffect.stepKey}`, updatedAt: now });
        await this.insertEvent(trx, row.id, int(row.lastSequence) + 1, "run.status", { status: "reconciliation_required" }, now, version);
        await this.insertEvent(trx, row.id, int(row.lastSequence) + 2, "run.error", { code: "RECONCILIATION_REQUIRED", stepKey: staleSideEffect.stepKey }, now, version);
        return null as never;
      }
      const epoch = int(row.leaseEpoch) + 1;
      const version = int(row.version) + 1;
      await trx(RUNS).where({ id: row.id }).update({ status: "running", version, leaseEpoch: epoch, leaseOwner: this.workerId, leaseUntil: now + this.leaseMs, updatedAt: now, errorCode: null, errorMessage: null });
      const next = await trx<RunRow>(RUNS).where({ id: row.id }).first() as RunRow;
      await this.insertEvent(trx, row.id, int(row.lastSequence) + 1, "run.status", { status: "running", workerId: this.workerId }, now, version);
      next.lastSequence = int(row.lastSequence) + 1;
      return { run: this.toView(next), epoch };
    });
  }

  private async executeClaimed(claimed: { run: BuiltinRunView; epoch: number }, controller: AbortController): Promise<void> {
    let heartbeat: NodeJS.Timeout | undefined;
    const context = this.makeContext(claimed.run, claimed.epoch, controller);
    heartbeat = setInterval(() => {
      void this.touchLease(claimed.run.id, claimed.epoch, controller);
    }, Math.max(20, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();
    try {
      await this.authorizeFn(claimed.run);
      const result = await this.executeFn(context);
      await context.assertActive();
      await this.db.transaction(async (trx) => {
        const row = await this.lockActiveRun(trx, claimed.run.id, claimed.epoch);
        const version = int(row.version) + 1;
        await trx(RUNS).where({ id: claimed.run.id }).update({ status: "succeeded", version, result: jsonValue(result), leaseOwner: null, leaseUntil: null, updatedAt: this.now(), currentStep: null });
        await this.insertEvent(trx, claimed.run.id, int(row.lastSequence) + 1, "run.status", { status: "succeeded" }, this.now(), version);
      });
    } catch (error) {
      if (controller.signal.aborted && this.stopped) {
        await this.releaseAfterStop(claimed.run.id, claimed.epoch);
        return;
      }
      if (error instanceof BuiltinRuntimeError && ["LEASE_LOST", "PAUSED", "CANCELLED", "WAITING_HUMAN", "RECONCILIATION_REQUIRED"].includes(error.code)) return;
      await this.failIfActive(claimed.run.id, claimed.epoch, error);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  private async releaseAfterStop(runId: string, epoch: number): Promise<void> {
    try {
      await this.db.transaction(async (trx) => {
        const row = await trx<RunRow>(RUNS).where({ id: runId }).forUpdate().first();
        if (!row || row.status !== "running" || row.leaseOwner !== this.workerId || int(row.leaseEpoch) !== epoch) return;
        const sideEffect = await trx<StepRow>(STEPS).where({ runId, status: "started", sideEffect: true }).first();
        const now = this.now();
        const nextEpoch = epoch + 1;
        if (sideEffect) {
          await trx(RUNS).where({ id: runId }).update({ leaseOwner: null, leaseUntil: null, leaseEpoch: nextEpoch, updatedAt: now });
          return;
        }
        const version = int(row.version) + 1;
        await trx(RUNS).where({ id: runId }).update({ status: "queued", version, leaseOwner: null, leaseUntil: null, leaseEpoch: nextEpoch, updatedAt: now });
        await this.insertEvent(trx, runId, int(row.lastSequence) + 1, "run.status", { status: "queued", reason: "runtime_stopped" }, now, version);
      });
    } catch { /* shutdown is best effort; an expired lease remains recoverable */ }
  }

  private makeContext(run: BuiltinRunView, epoch: number, controller: AbortController): BuiltinExecutionContext {
    return {
      run,
      signal: controller.signal,
      remainingOutputTokens: async () => {
        await this.assertForMutation(run.id, epoch, controller);
        const row = await this.db<RunRow>(RUNS).where({ id: run.id }).first();
        if (!row) throw new BuiltinRuntimeError("NOT_FOUND", "Builtin run not found");
        return Math.max(0, limitsOf(row.limits).maxOutputTokens - int(row.outputTokens));
      },
      assertActive: async () => {
        if (controller.signal.aborted) throw new BuiltinRuntimeError("LEASE_LOST", "Run executor was invalidated");
        const row = await this.db<RunRow>(RUNS).where({ id: run.id }).first();
        if (!row) throw new BuiltinRuntimeError("NOT_FOUND", "Builtin run not found");
        if (row.status === "paused") throw new BuiltinRuntimeError("PAUSED", "Run is paused");
        if (row.status === "cancelled") throw new BuiltinRuntimeError("CANCELLED", "Run is cancelled");
        if (row.status !== "running" || row.leaseOwner !== this.workerId || int(row.leaseEpoch) !== epoch || (row.leaseUntil !== null && int(row.leaseUntil) < this.now())) throw new BuiltinRuntimeError("LEASE_LOST", "Run lease is no longer valid");
        await this.authorizeFn(this.toView(row));
        await this.touchLease(run.id, epoch, controller);
      },
      waitForHuman: async (question, data) => {
        if (!question || question.length > 20_000) throw new BuiltinRuntimeError("INVALID_INPUT", "Human question is invalid");
        await this.assertForMutation(run.id, epoch, controller);
        await this.db.transaction(async (trx) => {
          const row = await this.lockActiveRun(trx, run.id, epoch);
          const version = int(row.version) + 1;
          const nextEpoch = int(row.leaseEpoch) + 1;
          const now = this.now();
          await trx(RUNS).where({ id: run.id }).update({ status: "waiting_human", version, leaseEpoch: nextEpoch, leaseOwner: null, leaseUntil: null, waitingQuestion: question, waitingData: jsonValue(data), updatedAt: now });
          await this.insertEvent(trx, run.id, int(row.lastSequence) + 1, "run.status", { status: "waiting_human", question, data: data ?? null }, now, version);
        });
        controller.abort();
        throw new BuiltinRuntimeError("WAITING_HUMAN", "Run is waiting for human input");
      },
      emit: async (type, data) => {
        await this.assertForMutation(run.id, epoch, controller);
        return this.db.transaction(async (trx) => {
          const row = await this.lockActiveRun(trx, run.id, epoch);
          const sequence = int(row.lastSequence) + 1;
          await this.insertEvent(trx, run.id, sequence, type, data, this.now(), int(row.version));
          return { runId: run.id, sequence, type, data, createdAt: this.now() };
        });
      },
      step: async <T>(key: string, input: unknown, perform: () => Promise<T> | T, options: BuiltinStepOptions = {}) => this.runStep(run, epoch, controller, key, input, perform, options),
      commit: async <T>(key: string, input: unknown, perform: (trx: Knex.Transaction) => Promise<T>) => this.runCommit(run, epoch, controller, key, input, perform),
    };
  }

  private async runStep<T>(run: BuiltinRunView, epoch: number, controller: AbortController, key: string, input: unknown, perform: () => Promise<T> | T, options: BuiltinStepOptions): Promise<T> {
    if (!key || key.length > 240) throw new BuiltinRuntimeError("INVALID_INPUT", "Step key is invalid");
    await this.assertForMutation(run.id, epoch, controller);
    const inputHash = hashInput(input);
    const started = await this.db.transaction(async (trx) => {
      const row = await this.lockActiveRun(trx, run.id, epoch);
      const existing = await trx<StepRow>(STEPS).where({ runId: run.id, stepKey: key }).forUpdate().first();
      if (existing?.status === "completed" && existing.inputHash === inputHash) return { replay: true, result: parseJson<T>(existing.result) as T };
      if (existing?.status === "completed") throw new BuiltinRuntimeError("CONFLICT", `Step ${key} already completed with different input`);
      if (existing && existing.inputHash !== inputHash) throw new BuiltinRuntimeError("CONFLICT", `Step ${key} cannot resume with different input`);
      if (existing?.status === "uncertain") throw new BuiltinRuntimeError("RECONCILIATION_REQUIRED", `Step ${key} requires reconciliation`);
      if (existing?.status === "started" && int(existing.startedEpoch) === epoch && existing.startedOwner === this.workerId) throw new BuiltinRuntimeError("CONFLICT", `Step ${key} is already running`);
      const limits = limitsOf(row.limits);
      const modelCall = Boolean(options.modelCall);
      // Durable media jobs resume under the same key; querying their saved receipt
      // consumes no additional generation authorization after a lease change.
      const imageGeneration = Boolean(options.imageGeneration && !existing?.imageGeneration);
      const videoGeneration = Boolean(options.videoGeneration && !existing?.videoGeneration);
      const intent = parseJson<Record<string, unknown>>(row.intent);
      // New runs count media against their own counters, rather than imposing
      // a hidden 40-image ceiling through the separate orchestration budget.
      const separateMediaStep = intent?.mediaBudgetMode === "zero_unlimited" && Boolean(options.imageGeneration || options.videoGeneration) && !modelCall;
      const updates: Record<string, unknown> = { updatedAt: this.now() };
      if (!separateMediaStep) updates.toolSteps = trx.raw('"toolSteps" + 1');
      if (modelCall) updates.modelCalls = trx.raw('"modelCalls" + 1');
      if (imageGeneration) updates.imageGenerations = trx.raw('"imageGenerations" + 1');
      if (videoGeneration) updates.videoGenerations = trx.raw('"videoGenerations" + 1');
      const conditions = trx(RUNS).where({ id: run.id, leaseOwner: this.workerId, leaseEpoch: epoch, status: "running" });
      if (!separateMediaStep) conditions.andWhere("toolSteps", "<", limits.maxToolSteps);
      if (modelCall) conditions.andWhere("modelCalls", "<", limits.maxModelCalls);
      if (imageGeneration && !hasUnlimitedMediaBudget({ limits, intent: parseJson(row.intent) }, "image")) {
        conditions.andWhere("imageGenerations", "<", limits.maxImageGenerations);
      }
      if (videoGeneration && !hasUnlimitedMediaBudget({ limits, intent: parseJson(row.intent) }, "video")) {
        conditions.andWhere("videoGenerations", "<", limits.maxVideoGenerations);
      }
      const changed = await conditions.update(updates);
      if (changed !== 1) throw new BuiltinRuntimeError("BUDGET_EXCEEDED", `Step budget exceeded for ${key}`);
      const now = this.now();
      await trx(STEPS).insert({ runId: run.id, stepKey: key, inputHash, input: jsonValue(input), status: "started", result: null, sideEffect: Boolean(options.sideEffect), modelCall, imageGeneration: Boolean(options.imageGeneration), videoGeneration: Boolean(options.videoGeneration), outputTokens: 0, attempt: existing ? int(existing.attempt) + 1 : 1, startedEpoch: epoch, startedOwner: this.workerId, startedAt: now, completedAt: null, updatedAt: now }).onConflict(["runId", "stepKey"]).merge();
      await trx(RUNS).where({ id: run.id }).update({ currentStep: key, updatedAt: now });
      await this.insertEvent(trx, run.id, int(row.lastSequence) + 1, "step.started", { key, inputHash }, now, int(row.version));
      return { replay: false, row };
    });
    if (started.replay) return started.result as T;
    let result: T;
    try {
      result = await perform();
    } catch (error) {
      if (options.modelCall && error instanceof StructuredModelOutputError) await this.recordModelOutputFailure(run.id, epoch, key, error);
      if (options.sideEffect) await this.markUncertain(run.id, epoch, key, error);
      throw error;
    }
    await this.assertForMutation(run.id, epoch, controller);
    const mediaResult = result as { status?: string; selected?: boolean } | null;
    const waitingOnMedia = (options.imageGeneration || options.videoGeneration) && mediaResult &&
      (mediaResult.status === "needs_reconciliation" || (run.agentType !== "productionAgent" && options.imageGeneration && mediaResult.status === "succeeded" && mediaResult.selected === false));
    if (waitingOnMedia) {
      // Keep the reservation, but do not cache a mutable reconciliation state
      // as final. On resume the capability reads the same durable job again.
      await this.db.transaction(async (trx) => {
        const row = await this.lockActiveRun(trx, run.id, epoch);
        await trx(STEPS).where({ runId: run.id, stepKey: key, status: "started", startedEpoch: epoch }).update({ result: jsonValue(result), updatedAt: this.now() });
        await this.insertEvent(trx, run.id, int(row.lastSequence) + 1, "step.waiting", { key, reason: "media_review" }, this.now(), int(row.version));
      });
      return parseJson<T>(jsonValue(result)) as T;
    }
    const tokens = modelCallTokens(result, options.modelCall);
    if (tokens > 0) await this.addOutputTokens(run.id, epoch, tokens);
    await this.db.transaction(async (trx) => {
      const row = await this.lockActiveRun(trx, run.id, epoch);
      const step = await trx<StepRow>(STEPS).where({ runId: run.id, stepKey: key }).forUpdate().first();
      if (!step || step.status !== "started" || step.inputHash !== inputHash) throw new BuiltinRuntimeError("LEASE_LOST", "Step was superseded");
      await trx(STEPS).where({ runId: run.id, stepKey: key }).update({ status: "completed", result: jsonValue(result), outputTokens: tokens, completedAt: this.now(), updatedAt: this.now() });
      await trx(RUNS).where({ id: run.id, currentStep: key }).update({ currentStep: null, updatedAt: this.now() });
      await this.insertEvent(trx, run.id, int(row.lastSequence) + 1, "step.completed", { key, replay: false }, this.now(), int(row.version));
    });
    return parseJson<T>(jsonValue(result)) as T;
  }

  private async runCommit<T>(run: BuiltinRunView, epoch: number, controller: AbortController, key: string, input: unknown, perform: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    if (!key || key.length > 240) throw new BuiltinRuntimeError("INVALID_INPUT", "Step key is invalid");
    await this.assertForMutation(run.id, epoch, controller);
    const inputHash = hashInput(input);
    return this.db.transaction(async (trx) => {
      const row = await this.lockActiveRun(trx, run.id, epoch);
      const existing = await trx<StepRow>(STEPS).where({ runId: run.id, stepKey: key }).forUpdate().first();
      if (existing?.status === "completed" && existing.inputHash === inputHash) return parseJson<T>(existing.result) as T;
      if (existing?.status === "completed") throw new BuiltinRuntimeError("CONFLICT", `Step ${key} already completed with different input`);
      if (existing?.status === "uncertain") throw new BuiltinRuntimeError("RECONCILIATION_REQUIRED", `Step ${key} requires reconciliation`);
      if (existing?.status === "started" && int(existing.startedEpoch) === epoch && existing.startedOwner === this.workerId) throw new BuiltinRuntimeError("CONFLICT", `Step ${key} is already running`);
      const limits = limitsOf(row.limits);
      const changed = await trx(RUNS).where({ id: run.id, leaseOwner: this.workerId, leaseEpoch: epoch, status: "running" }).andWhere("toolSteps", "<", limits.maxToolSteps).update({ toolSteps: trx.raw('"toolSteps" + 1') });
      if (changed !== 1) throw new BuiltinRuntimeError("BUDGET_EXCEEDED", `Step budget exceeded for ${key}`);
      const now = this.now();
      await trx(STEPS).insert({ runId: run.id, stepKey: key, inputHash, input: jsonValue(input), status: "started", result: null, sideEffect: false, modelCall: false, imageGeneration: false, videoGeneration: false, outputTokens: 0, attempt: existing ? int(existing.attempt) + 1 : 1, startedEpoch: epoch, startedOwner: this.workerId, startedAt: now, completedAt: null, updatedAt: now }).onConflict(["runId", "stepKey"]).merge();
      await trx(RUNS).where({ id: run.id }).update({ currentStep: key, updatedAt: now });
      await this.insertEvent(trx, run.id, int(row.lastSequence) + 1, "step.started", { key, inputHash }, now, int(row.version));
      const result = await perform(trx);
      await trx(STEPS).where({ runId: run.id, stepKey: key }).update({ status: "completed", result: jsonValue(result), completedAt: this.now(), updatedAt: this.now() });
      await trx(RUNS).where({ id: run.id, currentStep: key }).update({ currentStep: null, updatedAt: this.now() });
      const latest = await trx<RunRow>(RUNS).where({ id: run.id }).first() as RunRow;
      await this.insertEvent(trx, run.id, int(latest.lastSequence) + 1, "step.completed", { key, replay: false, committed: true }, this.now(), int(latest.version));
      return result;
    });
  }

  private async assertForMutation(runId: string, epoch: number, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) throw new BuiltinRuntimeError("LEASE_LOST", "Run executor was invalidated");
    const row = await this.db<RunRow>(RUNS).where({ id: runId }).first();
    if (!row) throw new BuiltinRuntimeError("NOT_FOUND", "Builtin run not found");
    if (row.status === "paused") throw new BuiltinRuntimeError("PAUSED", "Run is paused");
    if (row.status === "cancelled") throw new BuiltinRuntimeError("CANCELLED", "Run is cancelled");
    if (row.status !== "running" || row.leaseOwner !== this.workerId || int(row.leaseEpoch) !== epoch || (row.leaseUntil !== null && int(row.leaseUntil) < this.now())) throw new BuiltinRuntimeError("LEASE_LOST", "Run lease is no longer valid");
    await this.authorizeFn(this.toView(row));
  }

  private async lockActiveRun(trx: Knex.Transaction, runId: string, epoch: number, checkAuthority = true): Promise<RunRow> {
    const row = await trx<RunRow>(RUNS).where({ id: runId }).forUpdate().first();
    if (!row) throw new BuiltinRuntimeError("NOT_FOUND", "Builtin run not found");
    if (row.status === "paused") throw new BuiltinRuntimeError("PAUSED", "Run is paused");
    if (row.status === "cancelled") throw new BuiltinRuntimeError("CANCELLED", "Run is cancelled");
    if (row.status !== "running" || row.leaseOwner !== this.workerId || int(row.leaseEpoch) !== epoch || (row.leaseUntil !== null && int(row.leaseUntil) < this.now())) throw new BuiltinRuntimeError("LEASE_LOST", "Run lease is no longer valid");
    if (checkAuthority) await this.authorizeFn(this.toView(row), trx);
    return row;
  }

  private async touchLease(runId: string, epoch: number, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) return;
    const changed = await this.db(RUNS).where({ id: runId, leaseOwner: this.workerId, leaseEpoch: epoch, status: "running" }).update({ leaseUntil: this.now() + this.leaseMs, updatedAt: this.now() });
    if (changed !== 1) controller.abort();
  }

  private async addOutputTokens(runId: string, epoch: number, tokens: number): Promise<void> {
    await this.db.transaction(async (trx) => {
      const row = await this.lockActiveRun(trx, runId, epoch);
      const limits = limitsOf(row.limits);
      const query = trx(RUNS).where({ id: runId, leaseOwner: this.workerId, leaseEpoch: epoch, status: "running" });
      // Each new production call is bounded by its configured model. Keep actual
      // aggregate usage for reporting; do not make later stages share this cap.
      if (!hasIndependentProductionOutput(row.agentType, parseJson(row.intent))) query.andWhere("outputTokens", "<=", limits.maxOutputTokens - tokens);
      const changed = await query.update({ outputTokens: trx.raw('"outputTokens" + ?', [tokens]) });
      if (changed !== 1) throw new BuiltinRuntimeError("BUDGET_EXCEEDED", "Output token budget exceeded");
    });
  }

  private async recordModelOutputFailure(runId: string, epoch: number, key: string, error: StructuredModelOutputError): Promise<void> {
    try {
      await this.db.transaction(async (trx) => {
        const row = await this.lockActiveRun(trx, runId, epoch);
        const step = await trx<StepRow>(STEPS).where({ runId, stepKey: key }).forUpdate().first();
        if (!step || step.status !== "started" || int(step.startedEpoch) !== epoch || step.startedOwner !== this.workerId || step.result != null) return;
        const tokens = error.diagnostics.outputTokens ?? 0;
        await trx(STEPS).where({ runId, stepKey: key }).update({ result: jsonValue({ modelOutputFailure: error.diagnostics }), outputTokens: tokens, updatedAt: this.now() });
        // This is usage already reported by the provider, even if JSON validation
        // failed. Preserve the actual count instead of treating failure as free.
        if (tokens > 0) await trx(RUNS).where({ id: runId }).increment("outputTokens", tokens);
        await this.insertEvent(trx, runId, int(row.lastSequence) + 1, "model.output.failed", { key, code: error.code, ...error.diagnostics }, this.now(), int(row.version));
      });
    } catch { /* A later owner/control state must not be changed by this result. */ }
  }

  private async markUncertain(runId: string, epoch: number, key: string, error: unknown): Promise<void> {
    try {
      await this.db.transaction(async (trx) => {
        const row = await this.lockActiveRun(trx, runId, epoch);
        await trx(STEPS).where({ runId, stepKey: key }).update({ status: "uncertain", updatedAt: this.now() });
        const version = int(row.version) + 1;
        await trx(RUNS).where({ id: runId }).update({ status: "reconciliation_required", version, leaseOwner: null, leaseUntil: null, errorCode: "RECONCILIATION_REQUIRED", errorMessage: errorMessage(error), updatedAt: this.now() });
        await this.insertEvent(trx, runId, int(row.lastSequence) + 1, "run.status", { status: "reconciliation_required" }, this.now(), version);
        await this.insertEvent(trx, runId, int(row.lastSequence) + 2, "run.error", { code: "RECONCILIATION_REQUIRED", key, message: errorMessage(error) }, this.now(), version);
      });
    } catch { /* A takeover may have fenced this executor; the new owner will inspect the started step. */ }
  }

  private async failIfActive(runId: string, epoch: number, error: unknown): Promise<void> {
    try {
      await this.db.transaction(async (trx) => {
        const row = await this.lockActiveRun(trx, runId, epoch, false);
        const version = int(row.version) + 1;
        const revoked = ["FORBIDDEN", "USER_DISABLED", "ROLE_FORBIDDEN", "PROJECT_ACTION_FORBIDDEN"].includes((error as { code?: string })?.code ?? "");
        const status = revoked ? "paused" : "failed";
        const failureCode = error instanceof BuiltinRuntimeError || error instanceof StructuredModelOutputError ? error.code : "EXECUTION_FAILED";
        await trx(RUNS).where({ id: runId }).update({ status, version, leaseOwner: null, leaseUntil: null, errorCode: revoked ? "AUTHORITY_REVOKED" : failureCode, errorMessage: errorMessage(error), updatedAt: this.now() });
        await this.insertEvent(trx, runId, int(row.lastSequence) + 1, "run.status", { status, reason: revoked ? "authority_revoked" : undefined }, this.now(), version);
        await this.insertEvent(trx, runId, int(row.lastSequence) + 2, "run.error", { code: failureCode, message: errorMessage(error) }, this.now(), version);
      });
    } catch { /* lease was lost or control already changed the run */ }
  }

  private async insertEvent(trx: Knex.Transaction, runId: string, sequence: number, type: string, data: unknown, createdAt: number, _version: number): Promise<void> {
    await trx(EVENTS).insert({ runId, sequence, type, data: jsonValue(data), createdAt });
    await trx(RUNS).where({ id: runId }).update({ lastSequence: sequence, updatedAt: createdAt });
  }

  private toView(row: RunRow): BuiltinRunView {
    const view = {
      id: String(row.id),
      agentType: row.agentType,
      projectId: row.projectId === null || row.projectId === undefined ? null : Number(row.projectId),
      scriptId: row.scriptId === null || row.scriptId === undefined ? null : Number(row.scriptId),
      requestedBy: Number(row.requestedBy),
      executionUserId: Number(row.executionUserId ?? row.requestedBy),
      prompt: row.prompt,
      status: row.status,
      version: int(row.version),
      lastSequence: int(row.lastSequence),
      currentStep: row.currentStep ?? null,
      limits: limitsOf(row.limits),
      modelCalls: int(row.modelCalls),
      toolSteps: int(row.toolSteps),
      outputTokens: int(row.outputTokens),
      imageGenerations: int(row.imageGenerations),
      videoGenerations: int(row.videoGenerations),
      createdAt: int(row.createdAt),
      updatedAt: int(row.updatedAt),
      errorCode: row.errorCode ?? null,
      errorMessage: row.errorMessage ?? null,
      result: parseJson(row.result),
      inputRevision: int(row.inputRevision),
      continuation: row.continuation ?? "",
      intent: parseJson(row.intent),
    } as BuiltinRunView & RuntimeRunExtensions;
    return view;
  }

  private normalizeLimits(value: BuiltinRunLimits | undefined): BuiltinRunLimits {
    const limits = { ...defaultBuiltinRunLimits, ...(value ?? {}) };
    for (const [key, amount] of Object.entries(limits)) if (!Number.isInteger(amount) || amount < 0) throw new BuiltinRuntimeError("INVALID_INPUT", `Invalid run limit: ${key}`);
    return limits;
  }

  private validateCreate(input: CreateBuiltinRun): void {
    if (!input || !input.idempotencyKey || input.idempotencyKey.length > 240 || !input.prompt || input.prompt.length > 1_000_000) throw new BuiltinRuntimeError("INVALID_INPUT", "Invalid builtin run input");
    if (!["scriptAgent", "productionAgent"].includes(input.agentType)) throw new BuiltinRuntimeError("INVALID_INPUT", "Invalid agent type");
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505");
  }
}

function modelCallTokens(value: unknown, modelCall: boolean | undefined): number {
  return modelCall ? estimateOutputTokens(value) : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendContinuation(existing: string, reason?: string): string {
  const addition = (reason ?? "").trim();
  if (!addition) return existing;
  const next = existing ? `${existing}\n${addition}` : addition;
  if (next.length > 16_384) throw new BuiltinRuntimeError("INVALID_INPUT", "Human continuation exceeds 16K");
  return next;
}
