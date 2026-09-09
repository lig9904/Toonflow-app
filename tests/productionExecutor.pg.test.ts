import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureProductionStateSchema, ProductionStateService } from "../src/services/productionState";
import { BuiltinAgentRuntime, ensureBuiltinAgentRuntimeSchema } from "../src/services/builtinAgentRuntime";
import { createProductionAgentExecutor, type ProductionMediaCapability } from "../src/services/builtinAgent/productionExecutor";
import type { StructuredScriptModel } from "../src/services/builtinAgent/scriptExecutor";
import { defaultBuiltinRunLimits } from "../src/services/builtinAgent/contracts";
import { ensureCreativeWorkspaceSchema } from "../src/services/creativeWorkspace";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };

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
    const media: ProductionMediaCapability = { generateImage: async () => { mediaCalls.push("image"); return { status: "succeeded", jobId: 1 }; }, generateVideo: async () => { mediaCalls.push("video"); return { status: "succeeded", jobId: 2 }; } };
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["planning"], assetIds: [], storyboardIds: [], question: null, summary: "plan" } : { scriptPlan: "server plan", storyboardTable: "server table" }, []);
    const result = await runOnce(f, model, media);
    assert.equal(result.run.status, "succeeded");
    assert.deepEqual(mediaCalls, []);
    const saved = await f.db("o_agentWorkData").where({ projectId: f.projectId, episodesId: f.scriptId, key: "productionAgent" }).first();
    assert.deepEqual(JSON.parse(saved.data), { scriptPlan: "server plan", storyboardTable: "server table", planningVersion: 1 });
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
