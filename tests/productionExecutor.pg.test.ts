import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureProductionStateSchema, ProductionStateService } from "../src/services/productionState";
import { BuiltinAgentRuntime, ensureBuiltinAgentRuntimeSchema } from "../src/services/builtinAgentRuntime";
import { StructuredModelOutputError } from "../src/lib/structuredModelOutput";
import { createProductionAgentExecutor, type ProductionMediaCapability } from "../src/services/builtinAgent/productionExecutor";
import type { StructuredScriptModel } from "../src/services/builtinAgent/scriptExecutor";
import { defaultBuiltinRunLimits } from "../src/services/builtinAgent/contracts";
import { ensureCreativeWorkspaceSchema } from "../src/services/creativeWorkspace";
import { saveProductionPlanning } from "../src/services/productionFlow";
import { ensureAssetExtractionWorkspaceSchema } from "../src/services/assetExtractionWorkspace";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };

test("an authorized derived-image run renders existing unpictured children even when analysis adds none", options, async () => {
  const f = await fixture();
  try {
    const [childId] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, assetsId: f.assetId, name: "Existing child", type: "role", describe: "new outfit" });
    const mediaIds: number[] = [];
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["deriveAssets", "generateImages"], assetIds: [f.assetId], storyboardIds: [], question: null, summary: "Create derived images" } : { assets: [] }, []);
    const result = await runOnce(f, model, { generateImage: async (request) => { mediaIds.push(request.targetId); return { status: "succeeded", jobId: 1, selected: true }; } }, { ...defaultBuiltinRunLimits, maxImageGenerations: 1 });
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    assert.deepEqual(mediaIds, [childId]); assert.equal(result.run.imageGenerations, 1);
  } finally { await f.destroy(); }
});

test("director preview is emitted before its structured result is committed", options, async () => {
  const f = await fixture();
  try {
    const model: StructuredScriptModel = { async generate(request) {
      if (request.role === "productionAgent:decisionAgent") return { value: request.schema.parse({ actions: ["planning"], assetIds: [], storyboardIds: [], question: null, summary: "Plan" }), outputTokens: 10 };
      await request.onPartial?.({ scriptPlan: "Draft in progress" });
      assert.equal((await f.db("o_agentWorkData").where({ projectId: f.projectId, key: "productionAgent" })).length, 0);
      assert((await f.db("ext_builtin_run_events").where({ type: "artifact.preview" })).length > 0);
      return { value: request.schema.parse({ scriptPlan: "Completed plan" }), outputTokens: 100 };
    } };
    const result = await runOnce(f, model);
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    assert.equal(JSON.parse((await f.db("o_agentWorkData").where({ projectId: f.projectId, key: "productionAgent" }).first()).data).scriptPlan, "Completed plan");
  } finally { await f.destroy(); }
});

test("independent production resumes the same task without replaying its saved director plan", options, async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let storyboardCalls = 0, directorCalls = 0;
    const model: StructuredScriptModel = { async generate(request) {
      assert.equal(request.useModelOutputLimit, true);
      if (request.role === "productionAgent:decisionAgent") return { value: request.schema.parse({ actions: ["extractAssets", "planning", "deriveAssets", "storyboard"], assetIds: [f.assetId], storyboardIds: [], question: null, summary: "Plan and storyboard" }), outputTokens: 100 };
      if (request.role === "universalAi") return { value: request.schema.parse({ roles: [{ action: "reuse", assetId: f.assetId, expectedVersion: 0 }], scenes: [], props: [], summary: "Reuse" }), outputTokens: 600 };
      if (request.role === "productionAgent:deriveAssetsAgent") return { value: request.schema.parse({ assets: [] }), outputTokens: 7 };
      if (request.role === "productionAgent:directorPlanAgent") { directorCalls++; return { value: request.schema.parse({ scriptPlan: "Saved before interruption" }), outputTokens: 14000 }; }
      storyboardCalls++;
      if (storyboardCalls === 1) { entered(); await blocked; }
      return { value: request.schema.parse({ items: [{ id: null, expectedVersion: null, prompt: "Resumed shot", videoDesc: "", duration: 3, track: "A", shouldGenerateImage: 0, associateAssetsIds: [f.assetId] }], summary: "Done" }), outputTokens: 2000 };
    } };
    const agent = runtime(f, model);
    const created = await agent.create({ agentType: "productionAgent", projectId: f.projectId, scriptId: f.scriptId, requestedBy: 1, prompt: "Produce", idempotencyKey: "independent-output-resume", limits: defaultBuiltinRunLimits, intent: { outputBudgetMode: "model_per_call" } });
    const running = agent.runOnce();
    await Promise.race([waiting, running.then(() => { throw new Error("Run stopped before reaching storyboard"); })]);
    const current = await agent.get(created.run.id);
    const paused = await agent.control(current.id, current.version, "pause");
    release(); await running;
    await agent.control(current.id, paused.version, "resume");
    await agent.runOnce();
    const done = await agent.get(current.id);
    assert.equal(done.status, "succeeded", done.errorMessage ?? "");
    assert.equal(directorCalls, 1); assert.equal(storyboardCalls, 2);
    assert.equal(done.outputTokens, 16707);
    assert.equal((await f.db("o_storyboard").where({ scriptId: f.scriptId })).length, 1);
  } finally { release?.(); await f.destroy(); }
});

test("full production gives every model call an independent limit and saves an 18-shot episode beyond the old total", options, async () => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    const model: StructuredScriptModel = { async generate(request) {
      calls.push(request.role);
      assert.equal(request.useModelOutputLimit, true, "No stage may share the old 12000-token allowance");
      assert.equal(request.maxOutputTokens, 0, "The adapter resolves the configured model limit");
      let value: unknown, outputTokens: number;
      if (request.role === "productionAgent:decisionAgent") {
        value = { actions: ["extractAssets", "planning", "deriveAssets", "storyboard"], assetIds: [f.assetId], storyboardIds: [], question: null, summary: "Prepare" }; outputTokens = 135;
      } else if (request.role === "universalAi") {
        value = { roles: [{ action: "reuse", assetId: f.assetId, expectedVersion: 0 }], scenes: [], props: [], bindings: [{ scriptId: f.scriptId, assets: [{ kind: "existing", assetId: f.assetId }] }], summary: "Reuse" }; outputTokens = 608;
      } else if (request.role === "productionAgent:directorPlanAgent") {
        value = { scriptPlan: "Independent complete director plan" }; outputTokens = 7000;
      } else if (request.role === "productionAgent:deriveAssetsAgent") {
        assert.equal((request.input as any).flow.scriptPlan, "Independent complete director plan");
        value = { assets: [] }; outputTokens = 7;
      } else {
        assert.equal((request.input as any).flow.scriptPlan, "Independent complete director plan");
        value = { items: Array.from({ length: 18 }, (_, index) => ({ id: null, expectedVersion: null, prompt: `Independent shot ${index + 1}`, videoDesc: `Action ${index + 1}`, duration: index < 6 ? 4 : 3, track: `shot-${index}`, shouldGenerateImage: 0, associateAssetsIds: [f.assetId] })), summary: "18 shots" }; outputTokens = 10000;
      }
      return { value: request.schema.parse(value), outputTokens, maxOutputTokens: 384000 };
    } };
    const agent = runtime(f, model);
    const created = await agent.create({ agentType: "productionAgent", projectId: f.projectId, scriptId: f.scriptId, requestedBy: 1, prompt: "全部生成", idempotencyKey: "independent-output-full", limits: defaultBuiltinRunLimits, intent: { thinkLevel: 0, outputBudgetMode: "model_per_call" } });
    await agent.runOnce();
    const done = await agent.get(created.run.id);
    assert.equal(done.status, "succeeded", done.errorMessage ?? "");
    assert.equal(done.outputTokens, 17750);
    assert.equal(calls.length, 5);
    const shots = await f.db("o_storyboard").where({ projectId: f.projectId, scriptId: f.scriptId });
    assert.equal(shots.length, 18); assert.equal(shots.reduce((sum, row) => sum + Number(row.duration), 0), 60);
    const steps = await f.db("ext_builtin_run_steps").where({ runId: done.id, modelCall: true });
    assert(steps.every((step) => step.result.maxOutputTokens === 384000));
    const events = await agent.events(done.id);
    assert(events.some((event) => event.type === "artifact.saved" && (event.data as any).kind === "productionPlanning"));
    assert.equal(done.imageGenerations, 0); assert.equal(done.videoGenerations, 0);
  } finally { await f.destroy(); }
});

test("independent model output failures keep usage and earlier data without retrying", options, async () => {
  const f = await fixture();
  try {
    await saveProductionPlanning(f.db, f.projectId, f.scriptId, 0, { scriptPlan: "Human plan", storyboardTable: "Human table" });
    let calls = 0;
    const model: StructuredScriptModel = { async generate(request) {
      calls++;
      if (request.role === "productionAgent:decisionAgent") return { value: request.schema.parse({ actions: ["planning"], assetIds: [], storyboardIds: [], question: null, summary: "Plan" }), outputTokens: 100 };
      throw new StructuredModelOutputError("MODEL_OUTPUT_LIMIT", { role: request.role, maxOutputTokens: 24000, outputTokens: 24000, finishReason: "length", reasoningTokens: 0, textCharacters: 20000 });
    } };
    const agent = runtime(f, model);
    const created = await agent.create({ agentType: "productionAgent", projectId: f.projectId, scriptId: f.scriptId, requestedBy: 1, prompt: "Plan", idempotencyKey: "independent-output-failure", limits: defaultBuiltinRunLimits, intent: { outputBudgetMode: "model_per_call" } });
    await agent.runOnce();
    const done = await agent.get(created.run.id);
    assert.equal(done.status, "failed"); assert.equal(done.errorCode, "MODEL_OUTPUT_LIMIT");
    assert.equal(done.outputTokens, 24100); assert.equal(calls, 2);
    const data = JSON.parse((await f.db("o_agentWorkData").where({ projectId: f.projectId, episodesId: f.scriptId, key: "productionAgent" }).first()).data);
    assert.equal(data.scriptPlan, "Human plan"); assert.equal(data.storyboardTable, "Human table");
  } finally { await f.destroy(); }
});

test("independent image targets complete concurrently while one conflicted target waits for human review", options, async () => {
  const f = await fixture();
  try {
    const [bad, good] = await insertRowsReturningIds(f.db, "o_storyboard", [
      { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "bad", duration: "5", state: "未生成", shouldGenerateImage: 1 },
      { projectId: f.projectId, scriptId: f.scriptId, index: 1, prompt: "good", duration: "5", state: "未生成", shouldGenerateImage: 1 },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let concurrent = 0;
    const completed: number[] = [];
    const media: ProductionMediaCapability = { generateImage: async (input) => {
      concurrent++;
      if (concurrent === 2) release();
      await gate;
      if (input.targetId === bad) throw Object.assign(new Error("Human edited this shot"), { code: "CONFLICT" });
      completed.push(input.targetId);
      return { status: "succeeded", jobId: 99, selected: true };
    } };
    const result = await runOnce(f, modelFor(() => ({ actions: ["generateImages"], assetIds: [], storyboardIds: [bad, good], question: null, summary: "two shots" }), []), media, { ...defaultBuiltinRunLimits, maxImageGenerations: 2 });
    assert.equal(result.run.status, "waiting_human", result.run.errorMessage ?? "");
    assert.deepEqual(completed, [good]);
    const events = await result.agent.events(result.run.id);
    const pause = events.findLast((event) => event.type === "run.status");
    assert.equal((pause!.data as any).data.issues[0].targetId, bad);
    assert.equal((pause!.data as any).data.completed[0].targetId, good);
  } finally { await f.destroy(); }
});

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureProductionStateSchema(f.db);
  await ensureBuiltinAgentRuntimeSchema(f.db);
  await ensureCreativeWorkspaceSchema(f.db);
  await ensureAssetExtractionWorkspaceSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Production", projectType: "short", imageModel: "image:test", imageQuality: "1K", videoRatio: "16:9" });
  const [scriptId] = await insertRowsReturningIds(f.db, "o_script", { projectId, name: "Episode", content: "A script" });
  const [assetId] = await insertRowsReturningIds(f.db, "o_assets", { projectId, name: "Hero", type: "role", describe: "hero" });
  await f.db("o_scriptAssets").insert({ scriptId, assetId });
  return { ...f, projectId, scriptId, assetId };
}

function modelFor(values: (request: any) => unknown | Promise<unknown>, calls: string[]): StructuredScriptModel {
  return { async generate(request) { calls.push(request.role); return { value: request.schema.parse(await values(request)), outputTokens: 8 }; } };
}

function runtime(f: any, model: StructuredScriptModel, media?: ProductionMediaCapability, videoModelMetadata?: (modelKey: string) => Promise<{ mode?: unknown; resolution?: unknown; audio?: unknown }>) {
  return new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: createProductionAgentExecutor({ db: f.db, model, media, videoModelMetadata, loadSkill: async (name) => `skill:${name}` }) });
}

async function runOnce(f: any, model: StructuredScriptModel, media?: ProductionMediaCapability, limits = defaultBuiltinRunLimits, prompt = "produce", videoModelMetadata?: (modelKey: string) => Promise<{ mode?: unknown; resolution?: unknown; audio?: unknown }>) {
  const agent = runtime(f, model, media, videoModelMetadata);
  const created = await agent.create({ agentType: "productionAgent", projectId: f.projectId, scriptId: f.scriptId, requestedBy: 1, prompt, idempotencyKey: `production-${Math.random().toString(36).slice(2, 12)}`, limits });
  await agent.runOnce();
  return { agent, run: await agent.get(created.run.id) };
}

test("production plan executes selected phases in program order and creates real storyboard IDs", options, async () => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    const model = modelFor((request) => {
      if (request.role === "productionAgent:decisionAgent") return { actions: ["storyboard", "review"], assetIds: [f.assetId], storyboardIds: [], question: null, summary: "selected" };
      if (request.role === "productionAgent:storyboardTableAgent") return { items: [{ id: null, prompt: "hero shot", duration: 2, track: "A", videoDesc: "", shouldGenerateImage: 0, associateAssetsIds: [f.assetId], expectedVersion: null }], summary: "storyboard" };
      return { findings: ["looks good"], summary: "review" };
    }, calls);
    const result = await runOnce(f, model);
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    assert.deepEqual(calls, ["productionAgent:decisionAgent", "productionAgent:storyboardTableAgent", "productionAgent:supervisionAgent"]);
    const storyboard = await f.db("o_storyboard").where({ scriptId: f.scriptId }).first();
    assert.ok(storyboard?.id);
    assert.deepEqual((await f.db("o_assets2Storyboard").where({ storyboardId: storyboard.id })).map((row) => Number(row.assetId)), [f.assetId]);
  } finally { await f.destroy(); }
});

test("director planning is server-owned and unrequested media is never called", options, async () => {
  const f = await fixture();
  try {
    const mediaCalls: string[] = [];
    await saveProductionPlanning(f.db, f.projectId, f.scriptId, 0, { scriptPlan: "previous plan", storyboardTable: "human table" });
    const media: ProductionMediaCapability = { generateImage: async () => { mediaCalls.push("image"); return { status: "succeeded", jobId: 1 }; }, generateVideo: async () => { mediaCalls.push("video"); return { status: "succeeded", jobId: 2 }; } };
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["planning"], assetIds: [], storyboardIds: [], question: null, summary: "plan" } : { scriptPlan: "server plan" }, []);
    const result = await runOnce(f, model, media);
    assert.equal(result.run.status, "succeeded");
    assert.deepEqual(mediaCalls, []);
    const saved = await f.db("o_agentWorkData").where({ projectId: f.projectId, episodesId: f.scriptId, key: "productionAgent" }).first();
    assert.deepEqual(JSON.parse(saved.data), { scriptPlan: "server plan", storyboardTable: "human table", planningVersion: 2 });
  } finally { await f.destroy(); }
});

test("foreign references and missing media capability fail before mutation or expensive generation", options, async () => {
  const f = await fixture();
  try {
    let mediaCalls = 0;
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["storyboard", "generateImages"], assetIds: [], storyboardIds: [], question: null, summary: "bad" } : { items: [{ id: null, prompt: "bad", duration: 2, track: "A", videoDesc: "", shouldGenerateImage: 1, associateAssetsIds: [999], expectedVersion: null }], summary: "bad" }, []);
    const media: ProductionMediaCapability = { generateImage: async () => { mediaCalls += 1; return { status: "succeeded", jobId: 1 }; }, generateVideo: async () => ({ status: "succeeded", jobId: 2 }) };
    const result = await runOnce(f, model, media);
    assert.notEqual(result.run.status, "succeeded");
    assert.equal(mediaCalls, 0);
    assert.equal(await f.db("o_storyboard").where({ scriptId: f.scriptId }).count("id as count").first().then((row) => Number(row?.count)), 0);

    const missing = await runOnce(f, modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["generateImages"], assetIds: [], storyboardIds: [], question: null, summary: "media" } : { items: [], summary: "" }, []));
    assert.notEqual(missing.run.status, "succeeded");
  } finally { await f.destroy(); }
});

test("image generation checks requested limits and passes exact storyboard IDs to the durable capability", options, async () => {
  const f = await fixture();
  try {
    const [storyboardId] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "hero", duration: "2", track: "A", videoDesc: "", shouldGenerateImage: 1, state: "未生成" });
    const received: any[] = [];
    const media: ProductionMediaCapability = { generateImage: async (input) => { received.push(input); return { status: "succeeded", jobId: "img-job-1" }; }, generateVideo: async () => ({ status: "succeeded", jobId: "vid-job" }) };
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["generateImages"], assetIds: [], storyboardIds: [storyboardId], question: null, summary: "image" } : { items: [], summary: "" }, []);
    const result = await runOnce(f, model, media, { ...defaultBuiltinRunLimits, maxImageGenerations: 1 });
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    assert.equal(received.length, 1);
    assert.equal(received[0].projectId, f.projectId);
    assert.equal(received[0].scriptId, f.scriptId);
    assert.equal(received[0].storyboardId, storyboardId);
    const over = await runOnce(f, model, media, { ...defaultBuiltinRunLimits, maxImageGenerations: 0 });
    assert.notEqual(over.run.status, "succeeded");
  } finally { await f.destroy(); }
});

test("video generation deduplicates by real track and passes full provider parameters", options, async () => {
  const f = await fixture();
  try {
    await f.db("o_project").where({ id: f.projectId }).update({ mode: "text" });
    const [trackA] = await insertRowsReturningIds(f.db, "o_videoTrack", { projectId: f.projectId, scriptId: f.scriptId, duration: 0 });
    const [one] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "one", videoDesc: "one desc", duration: "2", track: "A", trackId: trackA, shouldGenerateImage: 0, state: "未生成" });
    const [two] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 1, prompt: "two", videoDesc: "two desc", duration: "3", track: "A", trackId: trackA, shouldGenerateImage: 0, state: "未生成" });
    const received: any[] = [];
    const media: ProductionMediaCapability = { generateVideo: async (input) => { received.push(input); return { status: "succeeded", jobId: "video-job" }; } };
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["generateVideos"], assetIds: [], storyboardIds: [one, two], question: null, summary: "video" } : { items: [], summary: "" }, []);
    const result = await runOnce(f, model, media, { ...defaultBuiltinRunLimits, maxVideoGenerations: 1 }, "produce", async () => ({ mode: "text", resolution: "720p", audio: false }));
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    assert.equal(received.length, 1);
    assert.equal(received[0].targetKind, "track"); assert.equal(received[0].targetId, trackA); assert.deepEqual(received[0].params.storyboardIds.sort(), [one, two].sort());
    assert.equal(received[0].params.duration, 5); assert.equal(received[0].params.mode, "text"); assert.equal(received[0].params.resolution, "720p");
  } finally { await f.destroy(); }
});

test("storyboard agent updates duration, track, image flag, and asset associations under the shared guard", options, async () => {
  const f = await fixture();
  try {
    const [oldAsset] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, name: "Old", type: "role", describe: "old" });
    const [storyboardId] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "old", duration: "2", track: "A", videoDesc: "old", shouldGenerateImage: 0, state: "未生成" });
    await f.db("o_assets2Storyboard").insert({ assetId: oldAsset, storyboardId });
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["storyboard"], assetIds: [], storyboardIds: [storyboardId], question: null, summary: "update" } : { items: [{ id: storyboardId, prompt: "updated", duration: 4, track: "B", videoDesc: "updated", shouldGenerateImage: 1, associateAssetsIds: [f.assetId], expectedVersion: null }], summary: "" }, []);
    const result = await runOnce(f, model);
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    const saved = await f.db("o_storyboard").where({ id: storyboardId }).first();
    assert.equal(saved.prompt, "updated"); assert.equal(Number(saved.duration), 4); assert.equal(saved.track, "B"); assert.equal(saved.shouldGenerateImage, 1);
    assert.deepEqual((await f.db("o_assets2Storyboard").where({ storyboardId })).map((row) => Number(row.assetId)), [f.assetId]);
  } finally { await f.destroy(); }
});

test("locked storyboard and human version conflict reject agent mutation", options, async () => {
  const f = await fixture();
  try {
    const [storyboardId] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "old", duration: "2", track: "A", videoDesc: "", shouldGenerateImage: 0, state: "未生成" });
    const state = new ProductionStateService(f.db);
    const initial = await state.getStoryboardState(f.projectId, storyboardId);
    await state.acquireLock({ projectId: f.projectId, storyboardId, expectedVersion: initial.state.version, actor: { id: "human:1", kind: "human" } });
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["storyboard"], assetIds: [], storyboardIds: [storyboardId], question: null, summary: "edit" } : { items: [{ id: storyboardId, prompt: "agent edit", duration: 2, track: "A", videoDesc: "", shouldGenerateImage: 0, associateAssetsIds: [], expectedVersion: initial.state.version },], summary: "" }, []);
    const result = await runOnce(f, model);
    assert.notEqual(result.run.status, "succeeded");
    assert.equal((await f.db("o_storyboard").where({ id: storyboardId }).first()).prompt, "old");
  } finally { await f.destroy(); }
});

test("human edit between flow read and agent commit rejects stale storyboard output", options, async () => {
  const f = await fixture();
  try {
    const [storyboardId] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "old", duration: "2", track: "A", videoDesc: "", shouldGenerateImage: 0, state: "未生成" });
    const state = new ProductionStateService(f.db);
    const initial = await state.getStoryboardState(f.projectId, storyboardId);
    const model = modelFor(async (request) => {
      if (request.role === "productionAgent:decisionAgent") return { actions: ["storyboard"], assetIds: [], storyboardIds: [storyboardId], question: null, summary: "edit" };
      await state.updateStoryboardContent({ projectId: f.projectId, storyboardId, expectedVersion: initial.state.version, actor: { id: "human:1", kind: "human" }, patch: { prompt: "human wins" } });
      return { items: [{ id: storyboardId, prompt: "stale agent", duration: 2, track: "A", videoDesc: "", shouldGenerateImage: 0, associateAssetsIds: [], expectedVersion: initial.state.version }], summary: "" };
    }, []);
    const result = await runOnce(f, model);
    assert.notEqual(result.run.status, "succeeded");
    assert.equal((await f.db("o_storyboard").where({ id: storyboardId }).first()).prompt, "human wins");
  } finally { await f.destroy(); }
});

test("human question pauses and continuation resumes under a new revision", options, async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const model: StructuredScriptModel = { async generate(request) {
      calls += 1;
      if (calls === 1) return { value: request.schema.parse({ actions: [], assetIds: [], storyboardIds: [], question: "Which episode?", summary: "need answer" }), outputTokens: 8 };
      if (request.role === "productionAgent:decisionAgent") return { value: request.schema.parse({ actions: ["review"], assetIds: [], storyboardIds: [], question: null, summary: "continued" }), outputTokens: 8 };
      return { value: request.schema.parse({ findings: [], summary: "reviewed" }), outputTokens: 8 };
    } };
    const agent = runtime(f, model);
    const created = await agent.create({ agentType: "productionAgent", projectId: f.projectId, scriptId: f.scriptId, requestedBy: 1, prompt: "plan", idempotencyKey: "production-human", limits: defaultBuiltinRunLimits });
    await agent.runOnce();
    const waiting = await agent.get(created.run.id);
    assert.equal(waiting.status, "waiting_human");
    const resumed = await agent.control(created.run.id, waiting.version, "resume", "Episode 2");
    assert.equal(resumed.inputRevision, 1);
    await agent.runOnce();
    const finished = await agent.get(created.run.id);
    assert.equal(finished.status, "succeeded", finished.errorMessage ?? "");
  } finally { await f.destroy(); }
});

test("legacy aliases execute once, 18 shots save atomically with a table, and unused tokens reach the long shot step", options, async () => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    const model: StructuredScriptModel = { async generate(request) {
      calls.push(request.role);
      if (request.role === "productionAgent:decisionAgent") {
        assert(!request.system.includes("run_sub_agent"));
        return { value: request.schema.parse({ actions: ["planning", "directorPlan", "storyboardTable", "storyboard"], assetIds: [], storyboardIds: [], question: null, summary: "CLAIM_ALREADY_SAVED" }), outputTokens: 100 };
      }
      if (request.role === "productionAgent:directorPlanAgent") return { value: request.schema.parse({ scriptPlan: "Compact director plan" }), outputTokens: 1000 };
      assert.equal(request.role, "productionAgent:storyboardTableAgent");
      assert.equal(request.maxOutputTokens, 10900, "Use actual remaining tokens instead of a fixed half-budget");
      return { value: request.schema.parse({ items: Array.from({ length: 18 }, (_, index) => ({ id: null, expectedVersion: null, prompt: `Shot ${index + 1}`, videoDesc: `Action ${index + 1}`, duration: index < 6 ? 4 : 3, track: `shot-${index}`, shouldGenerateImage: 0, associateAssetsIds: [f.assetId] })), summary: "shots" }), outputTokens: 6000 };
    } };
    const result = await runOnce(f, model);
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    assert.equal(calls.length, 3);
    assert.equal(result.run.outputTokens, 7100);
    const shots = await f.db("o_storyboard").where({ projectId: f.projectId, scriptId: f.scriptId });
    assert.equal(shots.length, 18);
    assert.equal(shots.reduce((sum, row) => sum + Number(row.duration), 0), 60);
    const planning = JSON.parse((await f.db("o_agentWorkData").where({ projectId: f.projectId, episodesId: f.scriptId, key: "productionAgent" }).first()).data);
    assert.equal(planning.scriptPlan, "Compact director plan");
    assert.match(planning.storyboardTable, /Shot 18/);
    const events = await result.agent.events(result.run.id);
    assert(!JSON.stringify(events).includes("CLAIM_ALREADY_SAVED"));
    assert.equal(result.run.imageGenerations, 0); assert.equal(result.run.videoGenerations, 0);
  } finally { await f.destroy(); }
});

test("upgrading the old varchar workspace preserves data and accepts long serialized plans", options, async () => {
  const { ensureBaseSchema } = await import("../src/lib/initDB");
  const f = await fixture();
  try {
    const oldData = JSON.stringify({ scriptPlan: "existing", storyboardTable: "old", planningVersion: 1 });
    await f.db("o_agentWorkData").insert({ projectId: f.projectId, episodesId: f.scriptId, key: "productionAgent", data: oldData });
    await f.db.raw('ALTER TABLE "o_agentWorkData" ALTER COLUMN "data" TYPE varchar(255)');
    await ensureBaseSchema(f.db);
    assert.equal((await f.db("o_agentWorkData").columnInfo("data")).type, "text");
    assert.equal((await f.db("o_agentWorkData").where({ projectId: f.projectId, key: "productionAgent" }).first()).data, oldData);
    const longPlan = "Detailed director planning. ".repeat(1000);
    await saveProductionPlanning(f.db, f.projectId, f.scriptId, 1, { scriptPlan: longPlan, storyboardTable: "old" });
    assert.equal(JSON.parse((await f.db("o_agentWorkData").where({ projectId: f.projectId, key: "productionAgent" }).first()).data).scriptPlan, longPlan);
    await ensureBaseSchema(f.db);
    assert.equal((await f.db("o_user").where({ id: 1 }).first()).name, "admin");
  } finally { await f.destroy(); }
});
