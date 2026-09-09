import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { lockProjectTransaction } from "../src/lib/dbTransaction";
import { BuiltinAgentRuntime, BuiltinRuntimeError, ensureBuiltinAgentRuntimeSchema, type BuiltinExecutionContext } from "../src/services/builtinAgentRuntime";
import { createNovelEventExecutor } from "../src/services/novelEventWorkspace/executor";
import {
  configureNovelEventRunStarter,
  deleteNovelEvent,
  ensureNovelEventWorkspaceSchema,
  initializeNovelEventRun,
  novelContentHash,
  prepareNovelEventRunContext,
  readNovelEvents,
  readNovelEventStates,
  startNovelEventRun,
} from "../src/services/novelEventWorkspace";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const code = (wanted: string) => (error: unknown) => (error as { code?: unknown })?.code === wanted;

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureNovelEventWorkspaceSchema(f.db);
  await ensureBuiltinAgentRuntimeSchema(f.db);
  const [project] = await f.db("o_project").insert({ name: "events", userId: 1 }).returning("id");
  const [otherProject] = await f.db("o_project").insert({ name: "other", userId: 1 }).returning("id");
  const projectId = Number(project.id), otherProjectId = Number(otherProject.id);
  const novels: number[] = [];
  for (const [index, text] of ["first source", "second source"].entries()) {
    const [row] = await f.db("o_novel").insert({ projectId, chapterIndex: index + 1, reel: "卷一", chapter: `第${index + 1}章`, chapterData: text, eventState: null }).returning("id");
    const novelId = Number(row.id);
    novels.push(novelId);
    await f.db("ext_creative_state").insert({ entityType: "novel", entityId: novelId, projectId, version: 1, updatedBy: "human:1", updatedAt: 1 });
  }
  return { ...f, projectId, otherProjectId, novels };
}

function request(f: Awaited<ReturnType<typeof fixture>>, key = "novel-events-one") {
  return { projectId: f.projectId, novelIds: f.novels, expectedVersions: Object.fromEntries(f.novels.map((id) => [String(id), 1])), idempotencyKey: key, concurrentCount: 2 };
}

test("novel event start snapshots real chapter IDs, versions and hashes and safely replays unknown requests", options, async () => {
  const f = await fixture();
  try {
    let created: any;
    configureNovelEventRunStarter(async ({ context, limits }) => {
      await f.db.transaction((trx) => initializeNovelEventRun(trx, context));
      created = { run: { id: "11111111-1111-4111-8111-111111111111", status: "queued", version: 0, intent: { phase: "novelEvents", context }, limits }, reused: false };
      await f.db("o_novel").whereIn("id", f.novels).update({ eventState: 1 });
      return created;
    }, async (_userId, key) => key === "novel-events-one" && created ? { ...created, reused: true } : undefined);
    const first = await startNovelEventRun(f.db, request(f), 1);
    const replay = await startNovelEventRun(f.db, request(f), 1);
    assert.equal(first.reused, false);
    assert.equal(replay.reused, true);
    assert.deepEqual(created.run.intent.context.chapters.map((item: any) => item.id), f.novels);
    assert(created.run.intent.context.chapters.every((item: any) => item.expectedVersion === 1 && /^[a-f0-9]{64}$/.test(item.contentHash)));
    assert.deepEqual(created.run.limits, { maxModelCalls: 2, maxToolSteps: 8, maxOutputTokens: 2400, maxImageGenerations: 0, maxVideoGenerations: 0 });
    assert.deepEqual((await f.db("o_novel").whereIn("id", f.novels).orderBy("id")).map((row) => row.eventState), [1, 1], "a fast worker completion is not overwritten after starter returns");
    await assert.rejects(startNovelEventRun(f.db, { ...request(f), novelIds: [f.novels[0]], expectedVersions: { [f.novels[0]]: 1 } }, 1), code("IDEMPOTENCY_CONFLICT"));
  } finally { await f.destroy(); }
});

test("beforeCreate initialization admits only one overlapping run while independent chapters can queue", options, async () => {
  const f = await fixture();
  try {
    const firstContext = await prepareNovelEventRunContext(f.db, { ...request(f, "context-first"), novelIds: [f.novels[0]], expectedVersions: { [f.novels[0]]: 1 } });
    const secondContext = await prepareNovelEventRunContext(f.db, { ...request(f, "context-second"), novelIds: [f.novels[1]], expectedVersions: { [f.novels[1]]: 1 } });
    const runtime = new BuiltinAgentRuntime({
      db: f.db,
      authorize: async () => undefined,
      execute: async () => ({}),
      beforeCreate: async (run, trx) => {
        const intent = run.intent as { phase?: unknown; context?: any } | undefined;
        if (intent?.phase === "novelEvents") await initializeNovelEventRun(trx, intent.context);
      },
    });
    const create = (idempotencyKey: string, context: any) => runtime.create({
      agentType: "scriptAgent", projectId: f.projectId, scriptId: null, requestedBy: 1, prompt: "提取事件", idempotencyKey,
      intent: { phase: "novelEvents", context },
      limits: { maxModelCalls: 1, maxToolSteps: 6, maxOutputTokens: 1200, maxImageGenerations: 0, maxVideoGenerations: 0 },
    });
    const overlapping = await Promise.allSettled([create("overlap-run-one", firstContext), create("overlap-run-two", firstContext)]);
    assert.equal(overlapping.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(overlapping.filter((result) => result.status === "rejected" && (result.reason as any)?.code === "VERSION_CONFLICT").length, 1);
    const independent = await create("independent-run", secondContext);
    assert.equal(independent.run.status, "queued");
    assert.equal((await f.db("ext_builtin_runs").where({ projectId: f.projectId, status: "queued" })).length, 2);
    assert.deepEqual((await f.db("o_novel").whereIn("id", f.novels).orderBy("id")).map((row) => row.eventState), [0, 0]);
  } finally { await f.destroy(); }
});

test("durable executor runs two chapters concurrently, saves complete relations, and rejects a post-model human edit", options, async () => {
  const f = await fixture();
  try {
    for (const novelId of f.novels) {
      const [event] = await f.db("o_event").insert({ name: `old-${novelId}`, detail: "old detail", createTime: 1 }).returning("id");
      await f.db("o_eventChapter").insert({ eventId: Number(event.id), novelId });
      await f.db("o_novel").where({ id: novelId }).update({ event: `old-${novelId}`, eventState: 1 });
    }
    const context = await prepareNovelEventRunContext(f.db, request(f, "executor-context"));
    let active = 0, peak = 0;
    const model = {
      async generate(request: any) {
        active += 1; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { value: {
          chapterLabel: `第${request.input.chapterIndex}章`, characters: "甲、乙", coreEvent: `事件${request.input.chapterIndex}`,
          mainlineRelation: "强（推动主线）", informationDensity: "高", estimatedDuration: "45秒", emotionalIntensity: "冲突+转折",
        }, outputTokens: 80 };
      },
    } as any;
    let humanWon = false;
    const emitted: Array<{ type: string; data: any }> = [];
    const ctx = {
      run: { id: "22222222-2222-4222-8222-222222222222", agentType: "scriptAgent", projectId: f.projectId, scriptId: null, requestedBy: 1,
        prompt: "提取事件", status: "running", version: 1, lastSequence: 1, currentStep: null,
        limits: { maxModelCalls: 2, maxToolSteps: 8, maxOutputTokens: 2400, maxImageGenerations: 0, maxVideoGenerations: 0 }, modelCalls: 0, toolSteps: 0,
        createdAt: 1, updatedAt: 1, errorCode: null, errorMessage: null, result: null, intent: { phase: "novelEvents", context } },
      signal: new AbortController().signal,
      async emit(type: string, data: any) { emitted.push({ type, data }); return { runId: "22222222-2222-4222-8222-222222222222", sequence: emitted.length, type, data, createdAt: Date.now() }; },
      async assertActive() {},
      async waitForHuman(question: string) { throw new BuiltinRuntimeError("WAITING_HUMAN", question); },
      async step(_key: string, _input: unknown, perform: () => any) { return perform(); },
      async commit(key: string, _input: unknown, perform: (trx: any) => Promise<any>) {
        if (!humanWon && key.includes(`save:${f.novels[0]}:`)) {
          humanWon = true;
          await f.db.transaction(async (trx) => {
            await lockProjectTransaction(trx, f.projectId);
            await trx("o_novel").where({ id: f.novels[0], projectId: f.projectId }).update({ chapterData: "human edit after model" });
            await trx("ext_creative_state").where({ entityType: "novel", entityId: f.novels[0], projectId: f.projectId }).update({ version: 2, updatedBy: "human:1", updatedAt: 2 });
          });
        }
        return f.db.transaction(perform);
      },
    } as unknown as BuiltinExecutionContext;
    const execute = createNovelEventExecutor({ db: f.db, model, fallbackPrompt: async () => "事件提取" });
    await assert.rejects(execute(ctx), code("WAITING_HUMAN"));
    assert.equal(peak, 2, "independent chapters execute with the bounded concurrency of two");
    const first = await f.db("o_novel").where({ id: f.novels[0] }).first();
    const second = await f.db("o_novel").where({ id: f.novels[1] }).first();
    assert.equal(first.event, `old-${f.novels[0]}`, "late stale output keeps the old event text");
    assert.equal(first.chapterData, "human edit after model");
    assert.match(second.event, /^\| 第2章 \|/);
    const firstLinks = await f.db("o_eventChapter").where({ novelId: f.novels[0] });
    const secondLinks = await f.db("o_eventChapter").where({ novelId: f.novels[1] });
    assert.equal(firstLinks.length, 1, "stale chapter keeps its prior event relationship");
    assert.equal(secondLinks.length, 1, "successful chapter has exactly one real event relationship");
    assert(await f.db("ext_novel_event_sources").where({ eventId: Number(secondLinks[0].eventId), sourceVersion: 1 }).first());
    const states = await readNovelEventStates(f.db, f.projectId, f.novels);
    assert.equal(states.find((item) => item.id === f.novels[0])?.eventState, -1);
    assert.equal(states.find((item) => item.id === f.novels[1])?.eventState, 1);
    assert(emitted.some((item) => item.type === "artifact.saved"));
  } finally { await f.destroy(); }
});

test("event list returns real chapter order and manual deletion enforces project, event ID, version and replay", options, async () => {
  const f = await fixture();
  try {
    const [event] = await f.db("o_event").insert({ name: "共享事件", detail: "详情", createTime: 10 }).returning("id");
    const eventId = Number(event.id);
    await f.db("o_eventChapter").insert(f.novels.slice().reverse().map((novelId) => ({ eventId, novelId })));
    await f.db("ext_creative_state").insert({ entityType: "event", entityId: eventId, projectId: f.projectId, version: 1, updatedBy: "human:1", updatedAt: 1 });
    await f.db("o_novel").where({ id: f.novels[0] }).update({ event: "旧事件", eventState: -1, errorReason: "模型未配置" });
    const failedState = (await readNovelEventStates(f.db, f.projectId, [f.novels[0]]))[0];
    assert.equal(failedState.event, "旧事件");
    assert.equal(failedState.eventState, -1);
    assert.equal(failedState.errorReason, "模型未配置");
    const list = await readNovelEvents(f.db, { projectId: f.projectId, page: 1, limit: 10 });
    assert.deepEqual(list.list[0].chapters, [1, 2]);
    assert.deepEqual(list.list[0].novelIds, f.novels);
    const linkId = Number((await f.db("o_eventChapter").where({ eventId }).first()).id);
    if (linkId !== eventId) await assert.rejects(deleteNovelEvent(f.db, { projectId: f.projectId, id: linkId, expectedVersion: 1, idempotencyKey: "wrong-link-id" }, { id: "human:1", kind: "human" }), code("PROJECT_MISMATCH"));
    await assert.rejects(deleteNovelEvent(f.db, { projectId: f.otherProjectId, id: eventId, expectedVersion: 1, idempotencyKey: "foreign-event" }, { id: "human:1", kind: "human" }), code("PROJECT_MISMATCH"));
    await assert.rejects(deleteNovelEvent(f.db, { projectId: f.projectId, id: eventId, expectedVersion: 0, idempotencyKey: "stale-event" }, { id: "human:1", kind: "human" }), code("VERSION_CONFLICT"));
    const deleted = await deleteNovelEvent(f.db, { projectId: f.projectId, id: eventId, expectedVersion: 1, idempotencyKey: "delete-event" }, { id: "human:1", kind: "human" });
    const replay = await deleteNovelEvent(f.db, { projectId: f.projectId, id: eventId, expectedVersion: 1, idempotencyKey: "delete-event" }, { id: "human:1", kind: "human" });
    assert.equal(deleted.reused, false);
    assert.equal(replay.reused, true);
    assert.equal(await f.db("o_event").where({ id: eventId }).first(), undefined);
    assert.equal(await f.db("o_eventChapter").where({ eventId }).first(), undefined);
  } finally { await f.destroy(); }
});
