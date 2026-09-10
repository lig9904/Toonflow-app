import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture } from "../src/lib/postgresTest";
import {
  BuiltinAgentRuntime,
  BuiltinRuntimeError,
  ensureBuiltinAgentRuntimeSchema,
} from "../src/services/builtinAgentRuntime";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };

test("unlimited media is not secretly capped by the orchestration step allowance", options, async () => {
  const f = await fixture();
  const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: async (ctx) => {
    await ctx.step("prepare", {}, () => "ready");
    for (let index = 0; index < 41; index++) await ctx.step(`image-${index}`, { index }, () => ({ jobId: index + 1, status: "succeeded" }), { imageGeneration: true });
    return ctx.step("review", {}, () => "done");
  } });
  try {
    const created = await runtime.create({ agentType: "productionAgent", projectId: 11, requestedBy: 1, prompt: "generate all", idempotencyKey: "unlimited-media-own-counter",
      intent: { mediaBudgetMode: "zero_unlimited" }, limits: { maxModelCalls: 0, maxToolSteps: 2, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    await runtime.runOnce(); const run = await runtime.get(created.run.id);
    assert.equal(run.status, "succeeded", run.errorMessage ?? "");
    assert.equal(run.imageGenerations, 41); assert.equal(run.toolSteps, 2);
  } finally { await runtime.stop(); await f.destroy(); }
});

test("resuming after media reconciliation reads the updated receipt without reserving another generation", options, async () => {
  const f = await fixture();
  let resolved = false, queries = 0;
  try {
    const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: async (ctx) => {
      const result = await ctx.step("image-result", { jobId: 1 }, async () => { queries++; return { jobId: 1, status: resolved ? "succeeded" : "needs_reconciliation", selected: resolved }; }, { imageGeneration: true });
      if (result.status !== "succeeded") await ctx.waitForHuman("请核对原任务", { jobId: result.jobId });
      return result;
    } });
    const created = await runtime.create({ agentType: "productionAgent", projectId: 11, requestedBy: 1, prompt: "generate", idempotencyKey: "mutable-media-receipt", limits: { maxModelCalls: 0, maxToolSteps: 4, maxOutputTokens: 100, maxImageGenerations: 1, maxVideoGenerations: 0 } });
    await runtime.runOnce();
    const waiting = await runtime.get(created.run.id); assert.equal(waiting.status, "waiting_human");
    resolved = true;
    await runtime.control(waiting.id, waiting.version, "resume", "原任务已恢复完成");
    await runtime.runOnce();
    const done = await runtime.get(waiting.id);
    assert.equal(done.status, "succeeded"); assert.equal(done.imageGenerations, 1); assert.equal(queries, 2);
  } finally { await f.destroy(); }
});

test("public zero-unlimited intent bypasses only media zero limits while legacy zero remains blocked", options, async () => {
  const f = await fixture();
  let calls = 0;
  const runtime = new BuiltinAgentRuntime({
    db: f.db,
    authorize: async () => undefined,
    execute: async (ctx) => ctx.step(`image-${ctx.run.id}`, { run: ctx.run.id }, async () => {
      calls += 1;
      return { status: "succeeded" };
    }, { imageGeneration: true }),
  });
  try {
    const unlimited = await runtime.create({
      agentType: "productionAgent", projectId: 11, requestedBy: 1, prompt: "new public run",
      idempotencyKey: "media-zero-unlimited", intent: { mediaBudgetMode: "zero_unlimited" },
      limits: { maxModelCalls: 0, maxToolSteps: 1, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 },
    });
    await runtime.runOnce();
    const unlimitedDone = await runtime.get(unlimited.run.id);
    assert.equal(unlimitedDone.status, "succeeded");
    assert.equal(unlimitedDone.imageGenerations, 1);
    assert.equal(calls, 1);

    const legacy = await runtime.create({
      agentType: "productionAgent", projectId: 11, requestedBy: 1, prompt: "old run",
      idempotencyKey: "media-zero-legacy",
      limits: { maxModelCalls: 0, maxToolSteps: 1, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 },
    });
    await runtime.runOnce();
    const legacyDone = await runtime.get(legacy.run.id);
    assert.equal(legacyDone.status, "failed");
    assert.equal(legacyDone.errorCode, "BUDGET_EXCEEDED");
    assert.equal(legacyDone.imageGenerations, 0);
    assert.equal(calls, 1);
  } finally {
    await runtime.stop();
    await f.destroy();
  }
});

test("revoked authority pauses a run and another authorized team member can take over without changing its creator", options, async () => {
  const f = await fixture();
  let revoked = false, calls = 0;
  const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async (run) => {
    const actor = run.executionUserId ?? run.requestedBy;
    if ((actor === 1 && revoked) || actor === 3) throw new BuiltinRuntimeError("FORBIDDEN", "revoked");
  }, execute: async () => { calls++; return "saved"; } });
  try {
    const created = await runtime.create({ agentType: "scriptAgent", projectId: 1, requestedBy: 1, prompt: "team", idempotencyKey: "team-authority-transfer", limits: { maxModelCalls: 1, maxToolSteps: 1, maxOutputTokens: 50, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    revoked = true;
    await runtime.runOnce();
    const paused = await runtime.get(created.run.id);
    assert.equal(paused.status, "paused"); assert.equal(calls, 0);
    await assert.rejects(runtime.control(paused.id, paused.version, "takeover", "forbidden", 3), /revoked/);
    const taken = await runtime.control(paused.id, paused.version, "takeover", "team member takes over", 2);
    const resumed = await runtime.control(taken.id, taken.version, "resume", undefined, 2);
    assert.equal(resumed.executionUserId, 2); assert.equal(resumed.requestedBy, 1);
    await runtime.runOnce();
    assert.equal((await runtime.get(taken.id)).status, "succeeded"); assert.equal(calls, 1);
  } finally { await runtime.stop(); await f.destroy(); }
});

async function fixture() {
  const f = await createPostgresFixture();
  await ensureBuiltinAgentRuntimeSchema(f.db);
  return f;
}

test("builtin runtime creates idempotently and replays ordered events", options, async () => {
  const f = await fixture();
  try {
    const runtime = new BuiltinAgentRuntime({ db: f.db, execute: async () => "unused", authorize: async () => undefined });
    const input = { agentType: "scriptAgent" as const, projectId: 11, requestedBy: 7, prompt: "hello", idempotencyKey: "runtime-create-1", limits: { maxModelCalls: 2, maxToolSteps: 4, maxOutputTokens: 50, maxImageGenerations: 0, maxVideoGenerations: 0 } };
    const first = await runtime.create(input);
    const second = await runtime.create(input);
    assert.equal(second.reused, true);
    assert.equal(second.run.id, first.run.id);
    assert.deepEqual((await runtime.events(first.run.id)).map((event) => event.sequence), [1]);
    await assert.rejects(runtime.create({ ...input, prompt: "changed" }), (error: unknown) => error instanceof BuiltinRuntimeError && error.code === "CONFLICT");
  } finally { await f.destroy(); }
});

test("idempotent replay is still authorization checked", options, async () => {
  const f = await fixture();
  try {
    let allowed = true;
    const authorize = async () => { if (!allowed) throw new BuiltinRuntimeError("FORBIDDEN", "revoked"); };
    const runtime = new BuiltinAgentRuntime({ db: f.db, execute: async () => undefined, authorize });
    const input = { agentType: "scriptAgent" as const, projectId: 11, requestedBy: 7, prompt: "auth", idempotencyKey: "runtime-auth-1", limits: { maxModelCalls: 0, maxToolSteps: 1, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 } };
    await runtime.create(input);
    allowed = false;
    await assert.rejects(runtime.create(input), (error: unknown) => error instanceof BuiltinRuntimeError && error.code === "FORBIDDEN");
  } finally { await f.destroy(); }
});

test("step replay and commit persist in PostgreSQL, with commit rollback", options, async () => {
  const f = await fixture();
  try {
    await f.db.schema.createTable("runtime_business", (table) => { table.text("id").primary(); table.text("value").notNullable(); });
    let calls = 0;
    const runtime = new BuiltinAgentRuntime({
      db: f.db,
      authorize: async () => undefined,
      execute: async (ctx) => {
        const one = await ctx.step("model", { n: 1 }, async () => { calls += 1; return { answer: "ok" }; }, { modelCall: true });
        const two = await ctx.step("model", { n: 1 }, async () => { calls += 1; return { answer: "bad" }; }, { modelCall: true });
        assert.deepEqual(two, one);
        await ctx.commit("save", { id: "a" }, async (trx) => {
          await trx("runtime_business").insert({ id: "a", value: "ok" });
          return { id: "a" };
        });
        await assert.rejects(ctx.commit("rollback", {}, async (trx) => {
          await trx("runtime_business").insert({ id: "b", value: "rolled back" });
          throw new Error("rollback");
        }));
        return { saved: true };
      },
    });
    const { run } = await runtime.create({ agentType: "scriptAgent", projectId: 11, requestedBy: 7, prompt: "run", idempotencyKey: "runtime-step-1", limits: { maxModelCalls: 2, maxToolSteps: 4, maxOutputTokens: 100, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    assert.equal(await runtime.runOnce(), true);
    assert.equal(calls, 1);
    assert.equal((await f.db("runtime_business").where({ id: "a" })).length, 1);
    assert.equal((await f.db("runtime_business").where({ id: "b" })).length, 0);
    assert.equal((await runtime.get(run.id)).status, "succeeded");
    assert.deepEqual((await runtime.events(run.id)).map((event) => event.type), ["run.created", "run.status", "step.started", "step.completed", "step.started", "step.completed", "run.status"]);
  } finally { await f.destroy(); }
});

test("side effect failure is reconciliation required and never retried", options, async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const runtime = new BuiltinAgentRuntime({
      db: f.db,
      authorize: async () => undefined,
      execute: async (ctx) => ctx.step("submit", { external: "x" }, async () => { calls += 1; throw new Error("unknown response"); }, { sideEffect: true }),
    });
    const { run } = await runtime.create({ agentType: "productionAgent", projectId: 11, requestedBy: 7, prompt: "submit", idempotencyKey: "runtime-side-effect-1", limits: { maxModelCalls: 0, maxToolSteps: 3, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    assert.equal(await runtime.runOnce(), true);
    assert.equal(calls, 1);
    assert.equal((await runtime.get(run.id)).status, "reconciliation_required");
    assert.equal(await runtime.runOnce(), false);
    assert.equal(calls, 1);
  } finally { await f.destroy(); }
});

test("takeover fences a late executor and counters stay within the tool budget", options, async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const runtime = new BuiltinAgentRuntime({
      db: f.db,
      workerId: "worker-a",
      leaseMs: 2_000,
      authorize: async () => undefined,
      execute: async (ctx) => {
        entered();
        await blocked;
        await ctx.commit("late", { x: 1 }, async (trx) => { await trx("runtime_business_missing").insert({}); return true; });
        return true;
      },
    });
    const { run } = await runtime.create({ agentType: "scriptAgent", projectId: 11, requestedBy: 7, prompt: "takeover", idempotencyKey: "runtime-takeover-1", limits: { maxModelCalls: 0, maxToolSteps: 1, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    const running = runtime.runOnce();
    await enteredPromise;
    const current = await runtime.get(run.id);
    const taken = await runtime.control(run.id, current.version, "takeover", "manual", 99);
    assert.equal(taken.status, "paused");
    release();
    await running;
    assert.equal((await runtime.get(run.id)).status, "paused");
  } finally { await f.destroy(); }
});

test("concurrent step reservations cannot exceed model and tool limits", options, async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const runtime = new BuiltinAgentRuntime({
      db: f.db,
      authorize: async () => undefined,
      execute: async (ctx) => {
        const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => ctx.step(`parallel-${index}`, { index }, async () => { calls += 1; return "ok"; }, { modelCall: true })));
        assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 2, JSON.stringify(outcomes));
        return true;
      },
    });
    const { run } = await runtime.create({ agentType: "scriptAgent", projectId: 11, requestedBy: 7, prompt: "budget", idempotencyKey: "runtime-budget-1", limits: { maxModelCalls: 2, maxToolSteps: 2, maxOutputTokens: 20, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    await runtime.runOnce();
    const saved = await runtime.get(run.id);
    assert.equal(saved.status, "succeeded", `${saved.errorCode}: ${saved.errorMessage}`);
    assert.equal(saved.modelCalls, 2);
    assert.equal(saved.toolSteps, 2);
    assert.equal(calls, 2);
  } finally { await f.destroy(); }
});

test("same step key cannot perform twice and changed completed input conflicts", options, async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    let concurrentError: unknown;
    const runtime = new BuiltinAgentRuntime({
      db: f.db,
      authorize: async () => undefined,
      execute: async (ctx) => {
        const first = ctx.step("once", { value: 1 }, async () => { calls += 1; await blocked; return "done"; });
        await new Promise((resolve) => setTimeout(resolve, 10));
        await assert.rejects(ctx.step("once", { value: 1 }, async () => { calls += 1; return "duplicate"; }), (error: unknown) => { concurrentError = error; return error instanceof BuiltinRuntimeError && error.code === "CONFLICT"; });
        release();
        await first;
        await assert.rejects(ctx.step("once", { value: 2 }, async () => "changed"), (error: unknown) => error instanceof BuiltinRuntimeError && error.code === "CONFLICT");
        return true;
      },
    });
    const { run } = await runtime.create({ agentType: "scriptAgent", projectId: 11, requestedBy: 7, prompt: "step conflict", idempotencyKey: "runtime-step-conflict-1", limits: { maxModelCalls: 0, maxToolSteps: 4, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    await runtime.runOnce();
    assert.equal(calls, 1);
    assert(concurrentError instanceof BuiltinRuntimeError);
    assert.equal((await runtime.get(run.id)).status, "succeeded");
  } finally { await f.destroy(); }
});

test("runtime conflicts fail the snapshot instead of silently entering a human wait", options, async () => {
  const f = await fixture();
  try {
    const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: async () => { throw new BuiltinRuntimeError("CONFLICT", "source changed"); } });
    const created = await runtime.create({ agentType: "productionAgent", projectId: 11, scriptId: 1, requestedBy: 7, prompt: "conflict", idempotencyKey: "runtime-conflict-terminal", limits: { maxModelCalls: 0, maxToolSteps: 1, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    await runtime.runOnce();
    const done = await runtime.get(created.run.id);
    assert.equal(done.status, "failed");
    assert.equal(done.errorCode, "CONFLICT");
    assert.equal((await f.db("ext_builtin_runs").where({ id: created.run.id }).first()).waitingQuestion, null);
  } finally { await f.destroy(); }
});

test("waitForHuman is resumable from a durable waiting_human stop", options, async () => {
  const f = await fixture();
  try {
    let executions = 0;
    const runtime = new BuiltinAgentRuntime({
      db: f.db,
      authorize: async () => undefined,
      execute: async (ctx) => {
        executions += 1;
        if (executions === 1) await ctx.waitForHuman("Choose a style", { choices: ["A", "B"] });
        return { done: true };
      },
    });
    const { run } = await runtime.create({ agentType: "scriptAgent", projectId: 11, requestedBy: 7, prompt: "human", idempotencyKey: "runtime-human-1", limits: { maxModelCalls: 0, maxToolSteps: 1, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    await runtime.runOnce();
    const waiting = await runtime.get(run.id);
    assert.equal(waiting.status, "waiting_human");
    assert.equal(waiting.inputRevision, 0);
    assert.equal(waiting.continuation, "");
    const resumed = await runtime.control(run.id, waiting.version, "resume", "Use style B");
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.inputRevision, 1);
    assert.equal(resumed.continuation, "Use style B");
    await runtime.runOnce();
    assert.equal((await runtime.get(run.id)).status, "succeeded");
    assert.equal(executions, 2);
  } finally { await f.destroy(); }
});

test("ordinary pause/resume preserves continuation and takeover advances revision", options, async () => {
  const f = await fixture();
  try {
    const runtime = new BuiltinAgentRuntime({ db: f.db, execute: async () => true, authorize: async () => undefined });
    const { run } = await runtime.create({ agentType: "scriptAgent", projectId: 11, requestedBy: 7, prompt: "controls", idempotencyKey: "runtime-controls-1", limits: { maxModelCalls: 0, maxToolSteps: 1, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    const paused = await runtime.control(run.id, run.version, "pause", "manual pause");
    assert.equal(paused.status, "paused");
    assert.equal(paused.inputRevision, 0);
    assert.equal(paused.continuation, "");
    const resumed = await runtime.control(run.id, paused.version, "resume", "ignored while ordinary pause");
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.inputRevision, 0);
    assert.equal(resumed.continuation, "");
    const taken = await runtime.control(run.id, resumed.version, "takeover", "human takeover");
    assert.equal(taken.status, "paused");
    assert.equal(taken.inputRevision, 1);
    assert.equal(taken.continuation, "");
  } finally { await f.destroy(); }
});

test("two runtime instances recover an expired lease and fence the late writer", options, async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let lateError: unknown;
    await f.db.schema.createTable("runtime_late_business", (table) => { table.text("id").primary(); });
    const runtime1 = new BuiltinAgentRuntime({
      db: f.db, workerId: "worker-expired-1", leaseMs: 10_000, authorize: async () => undefined,
      execute: async (ctx) => { entered(); await blocked; try { await ctx.commit("late", { id: "late" }, async (trx) => { await trx("runtime_late_business").insert({ id: "late" }); return true; }); } catch (error) { lateError = error; } return true; },
    });
    const runtime2 = new BuiltinAgentRuntime({ db: f.db, workerId: "worker-expired-2", leaseMs: 10_000, authorize: async () => undefined, execute: async () => true });
    const { run } = await runtime1.create({ agentType: "productionAgent", projectId: 11, requestedBy: 7, prompt: "expired", idempotencyKey: "runtime-expired-1", limits: { maxModelCalls: 0, maxToolSteps: 2, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    const first = runtime1.runOnce();
    await enteredPromise;
    await f.db("ext_builtin_runs").where({ id: run.id }).update({ leaseUntil: 0 });
    assert.equal(await runtime2.runOnce(), true);
    assert.equal((await runtime2.get(run.id)).status, "succeeded");
    release();
    await first;
    assert(lateError instanceof BuiltinRuntimeError);
    assert.equal((lateError as BuiltinRuntimeError).code, "LEASE_LOST");
    assert.equal((await f.db("runtime_late_business")).length, 0);
  } finally { await f.destroy(); }
});

test("stop releases a blocked non-side-effect run without marking it failed", options, async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const runtime = new BuiltinAgentRuntime({ db: f.db, workerId: "worker-stop", leaseMs: 10_000, authorize: async () => undefined, execute: async () => { entered(); await blocked; return true; } });
    const { run } = await runtime.create({ agentType: "scriptAgent", projectId: 11, requestedBy: 7, prompt: "stop", idempotencyKey: "runtime-stop-1", limits: { maxModelCalls: 0, maxToolSteps: 1, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    const running = runtime.runOnce();
    await enteredPromise;
    const startedAt = Date.now();
    await runtime.stop();
    assert(Date.now() - startedAt < 900);
    assert.equal((await runtime.get(run.id)).status, "queued");
    release();
    await running;
  } finally { await f.destroy(); }
});

test("maxConcurrentRuns bounds local polling claims", options, async () => {
  const f = await fixture();
  try {
    let entered = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new BuiltinAgentRuntime({ db: f.db, maxConcurrentRuns: 2, authorize: async () => undefined, execute: async () => { entered += 1; await blocked; return true; } });
    const make = (key: string) => runtime.create({ agentType: "scriptAgent", projectId: 11, requestedBy: 7, prompt: key, idempotencyKey: key, limits: { maxModelCalls: 0, maxToolSteps: 1, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    await make("runtime-concurrency-1"); await make("runtime-concurrency-2"); await make("runtime-concurrency-3");
    const first = runtime.runOnce();
    const second = runtime.runOnce();
    for (let i = 0; i < 20 && entered < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(entered, 2);
    assert.equal(await runtime.runOnce(), false);
    release();
    await Promise.all([first, second]);
  } finally { await f.destroy(); }
});

test("failed structured output records provider usage and diagnostics without committing an artifact", options, async () => {
  const { StructuredModelOutputError } = await import("../src/lib/structuredModelOutput");
  const f = await fixture();
  try {
    let saved = false;
    const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: async (ctx) => {
      await ctx.step("director", {}, async () => { throw new StructuredModelOutputError("MODEL_OUTPUT_LIMIT", { role: "productionAgent:directorPlanAgent", finishReason: "length", maxOutputTokens: 5100, outputTokens: 5100, reasoningTokens: 3000, textCharacters: 900 }); }, { modelCall: true });
      saved = true;
    } });
    const created = await runtime.create({ agentType: "productionAgent", projectId: 1, requestedBy: 1, prompt: "fixture", idempotencyKey: "output-failure-usage", limits: { maxModelCalls: 2, maxToolSteps: 4, maxOutputTokens: 12000, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    await runtime.runOnce();
    const run = await runtime.get(created.run.id);
    assert.equal(run.status, "failed"); assert.equal(run.errorCode, "MODEL_OUTPUT_LIMIT"); assert.equal(run.outputTokens, 5100);
    assert.equal(saved, false); assert.equal(run.modelCalls, 1);
    const events = await runtime.events(run.id);
    assert(events.some(e => e.type === "model.output.failed" && (e.data as any).finishReason === "length"));
    const step = await f.db("ext_builtin_run_steps").where({ runId: run.id, stepKey: "director" }).first();
    assert.equal(step.outputTokens, 5100); assert.equal(step.status, "started");
  } finally { await f.destroy(); }
});
