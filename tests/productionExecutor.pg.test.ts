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
import { finishLegacyProductionWaits } from "../src/services/builtinAgent/finishLegacyProductionWaits";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };

test("new zero-unlimited media runs reach the media executor while text-only scope stays text-only", options, async () => {
  const f = await fixture(); let images = 0;
  try {
    const model = modelFor((request) => {
      if (request.role === "productionAgent:decisionAgent") {
        assert.equal(request.input.authorization.imageUnlimited, true);
        return { actions: ["generateImages"], assetIds: [f.assetId], storyboardIds: [], question: null, summary: "image" };
      }
      return { scriptPlan: "The requested director plan" };
    }, []);
    const agent = runtime(f, model, { generateImage: async () => { images++; return { jobId: 1, status: "succeeded", selected: true }; } });
    for (const [key, prompt] of [["unlimited-image", "生成图片"], ["unlimited-plan-only", "只生成导演计划"]]) {
      const created = await agent.create({ agentType: "productionAgent", projectId: f.projectId, scriptId: f.scriptId, requestedBy: 1, prompt, idempotencyKey: key,
        limits: defaultBuiltinRunLimits, intent: { mediaBudgetMode: "zero_unlimited" } });
      await agent.runOnce(); assert.equal((await agent.get(created.run.id)).status, "succeeded", (await agent.get(created.run.id)).errorMessage ?? "");
    }
    assert.equal(images, 1);
    const planning = JSON.parse((await f.db("o_agentWorkData").where({ projectId: f.projectId, key: "productionAgent" }).first()).data);
    assert.equal(planning.scriptPlan, "The requested director plan");
  } finally { await f.destroy(); }
});

test("structured storyboard output repairs an exact omitted visible character before saving", options, async () => {
  const f = await fixture();
  try {
    const [baili] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, name: "雪璃", type: "role", describe: "成年狐族女性" });
    await f.db("o_scriptAssets").insert({ scriptId: f.scriptId, assetId: baili });
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent"
      ? { actions: ["storyboard"], assetIds: [], storyboardIds: [], question: null, summary: "storyboard" }
      : { items: [{ id: null, prompt: "Hero抱臂，雪璃压住笑声。近景。", videoDesc: "Hero说：『今天安静。』", duration: 3, track: "S06", shouldGenerateImage: 1, associateAssetsIds: [f.assetId] }], summary: "S06" }, []);
    const result = await runOnce(f, model);
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    const board = await f.db("o_storyboard").where({ projectId: f.projectId }).first();
    assert.deepEqual((await f.db("o_assets2Storyboard").where({ storyboardId: board.id }).orderBy("id")).map((row) => Number(row.assetId)), [f.assetId, baili]);
    assert.match(board.videoDesc, /今天安静/);
  } finally { await f.destroy(); }
});

test("a script changed during director planning rejects the obsolete plan", options, async () => {
  const f = await fixture();
  try {
    const model = modelFor(async (request) => {
      if (request.role === "productionAgent:decisionAgent") return { actions: ["planning"], assetIds: [], storyboardIds: [], question: null, summary: "plan" };
      await f.db("o_script").where({ id: f.scriptId }).update({ content: "Human revised the episode" });
      return { scriptPlan: "Stale plan" };
    }, []);
    const result = await runOnce(f, model);
    assert.equal(result.run.status, "failed"); assert.match(result.run.errorMessage ?? "", /剧本.*已被修改/);
    assert.equal((await f.db("o_agentWorkData").where({ projectId: f.projectId, key: "productionAgent" })).length, 0);
  } finally { await f.destroy(); }
});

test("new storyboard rows cannot be written from an obsolete character identity snapshot", options, async () => {
  const f = await fixture();
  try {
    const model = modelFor(async (request) => {
      if (request.role === "productionAgent:decisionAgent") return { actions: ["storyboard"], assetIds: [], storyboardIds: [], question: null, summary: "board" };
      await f.db("o_assets").where({ id: f.assetId }).update({ describe: "Human changed the role" });
      return { items: [{ id: null, prompt: "Hero faces the sea", videoDesc: "Static shot", duration: 3, track: "S01", shouldGenerateImage: 0, associateAssetsIds: [f.assetId] }], summary: "board" };
    }, []);
    const result = await runOnce(f, model);
    assert.equal(result.run.status, "failed"); assert.match(result.run.errorMessage ?? "", /素材设定已被修改/);
    assert.equal((await f.db("o_storyboard").where({ projectId: f.projectId })).length, 0);
  } finally { await f.destroy(); }
});

test("a saved but unapplied image does not block later production review", options, async () => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["generateImages", "review"], assetIds: [f.assetId], storyboardIds: [], question: null, summary: "Image and review" } : { findings: [], summary: "Reviewed" }, calls);
    const result = await runOnce(f, model, { generateImage: async () => ({ status: "succeeded", jobId: 1, artifactPath: "/1/assets/retained.jpg", selected: false }) }, { ...defaultBuiltinRunLimits, maxImageGenerations: 1 });
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    assert.equal((result.run.result as any).outcome, "complete_with_notes");
    assert(calls.includes("productionAgent:supervisionAgent"));
    const imageStep = await f.db("ext_builtin_run_steps").where({ runId: result.run.id, imageGeneration: true }).first();
    assert.equal(imageStep.status, "completed");
    assert.equal((await f.db("ext_builtin_runs").where({ id: result.run.id }).first()).waitingQuestion, null);
  } finally { await f.destroy(); }
});

test("same-name derived output reuses the existing entity without overwriting its description or billing twice", options, async () => {
  const f = await fixture();
  try {
    const [child] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, assetsId: f.assetId, type: "role", name: "Existing variant", describe: "Human description" });
    const generated: number[] = [];
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["deriveAssets", "generateImages"], assetIds: [f.assetId], storyboardIds: [], question: null, summary: "Use variants" } : { assets: [{ id: null, expectedVersion: null, parentAssetId: f.assetId, name: "Existing variant", description: "Unrequested replacement" }] }, []);
    const result = await runOnce(f, model, { generateImage: async (request) => { generated.push(request.targetId); return { jobId: 1, status: "succeeded", selected: true }; } }, { ...defaultBuiltinRunLimits, maxImageGenerations: 1 });
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    assert.deepEqual(generated, [child]);
    assert.equal((await f.db("o_assets").where({ assetsId: f.assetId })).length, 1);
    assert.equal((await f.db("o_assets").where({ id: child }).first()).describe, "Human description");
  } finally { await f.destroy(); }
});

test("legacy production waits end idempotently without replaying work or changing script-agent waits", options, async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const agent = new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: async (ctx) => {
      calls++;
      await ctx.waitForHuman("Old handoff", ctx.run.prompt === "saved" ? { action: "generateImages", completed: [{ result: { status: "succeeded", artifactPath: "/1/assets/saved.jpg" } }], issues: [{ result: { status: "succeeded" } }] } : {});
    } });
    const ids: string[] = [];
    for (const [agentType, prompt] of [["productionAgent", "saved"], ["productionAgent", "empty"], ["scriptAgent", "script"]] as const) {
      const created = await agent.create({ agentType, prompt, projectId: f.projectId, scriptId: f.scriptId, requestedBy: 1, idempotencyKey: `legacy-wait-${prompt}`, limits: defaultBuiltinRunLimits });
      ids.push(created.run.id); await agent.runOnce();
    }
    assert.equal(await finishLegacyProductionWaits(f.db), 2);
    assert.equal(await finishLegacyProductionWaits(f.db), 0);
    assert.equal((await agent.get(ids[0])).status, "succeeded");
    assert.equal(((await agent.get(ids[0])).result as any).outcome, "complete_with_notes");
    assert.equal((await agent.get(ids[1])).status, "failed");
    assert.equal((await agent.get(ids[2])).status, "waiting_human");
    assert.equal(calls, 3);
    assert.equal(await agent.runOnce(), false);
  } finally { await f.destroy(); }
});

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
    let storyboardCalls = 0, directorCalls = 0, skillLoads = 0;
    let skillVersion = "PRODUCTION-SKILL-V1";
    await f.db("o_prompt").where({ type: "scriptAssetExtraction" }).update({ useData: "PRODUCTION-COMMON-V1" });
    const model: StructuredScriptModel = { async generate(request) {
      assert.equal(request.useModelOutputLimit, true);
      if (request.role === "universalAi") assert.match(request.system, /PRODUCTION-COMMON-V1/);
      else if (request.role !== "productionAgent:decisionAgent") assert.match(request.system, /PRODUCTION-SKILL-V1/);
      if (request.role === "productionAgent:decisionAgent") return { value: request.schema.parse({ actions: ["extractAssets", "planning", "deriveAssets", "storyboard"], assetIds: [f.assetId], storyboardIds: [], question: null, summary: "Plan and storyboard" }), outputTokens: 100 };
      if (request.role === "universalAi") return { value: request.schema.parse({ roles: [{ action: "reuse", assetId: f.assetId, expectedVersion: 0 }], scenes: [], props: [], bindings: [{scriptId:f.scriptId,assets:[{kind:"existing",assetId:f.assetId}]}], summary: "Reuse" }), outputTokens: 600 };
      if (request.role === "productionAgent:deriveAssetsAgent") return { value: request.schema.parse({ assets: [] }), outputTokens: 7 };
      if (request.role === "productionAgent:directorPlanAgent") { directorCalls++; return { value: request.schema.parse({ scriptPlan: "Saved before interruption" }), outputTokens: 14000 }; }
      storyboardCalls++;
      if (storyboardCalls === 1) { entered(); await blocked; }
      return { value: request.schema.parse({ items: [{ id: null, expectedVersion: null, prompt: "Resumed shot", videoDesc: "", duration: 3, track: "A", shouldGenerateImage: 0, associateAssetsIds: [f.assetId] }], summary: "Done" }), outputTokens: 2000 };
    } };
    const agent = new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: createProductionAgentExecutor({ db: f.db, model, loadSkill: async (name) => { skillLoads += 1; return `${skillVersion}:${name}`; } }) });
    const created = await agent.create({ agentType: "productionAgent", projectId: f.projectId, scriptId: f.scriptId, requestedBy: 1, prompt: "Produce", idempotencyKey: "independent-output-resume", limits: defaultBuiltinRunLimits, intent: { outputBudgetMode: "model_per_call" } });
    const running = agent.runOnce();
    await Promise.race([waiting, running.then(() => { throw new Error("Run stopped before reaching storyboard"); })]);
    const current = await agent.get(created.run.id);
    const paused = await agent.control(current.id, current.version, "pause");
    skillVersion = "PRODUCTION-SKILL-V2";
    await f.db("o_prompt").where({ type: "scriptAssetExtraction" }).update({ useData: "PRODUCTION-COMMON-V2" });
    release(); await running;
    await agent.control(current.id, paused.version, "resume");
    await agent.runOnce();
    const done = await agent.get(current.id);
    assert.equal(done.status, "succeeded", done.errorMessage ?? "");
    assert.equal(directorCalls, 1); assert.equal(storyboardCalls, 2);
    assert.equal(done.outputTokens, 16707);
    assert.equal(skillLoads, 4);
    const promptSnapshot = await f.db("ext_builtin_run_steps").where({ runId: current.id, stepKey: "production.promptSnapshot" }).first();
    assert.equal(promptSnapshot.attempt, 1); assert.equal(promptSnapshot.modelCall, false);
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

test("independent image targets finish without a human handoff when one target conflicts", options, async () => {
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
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    assert.deepEqual(completed, [good]);
    assert.equal((result.run.result as any).outcome, "partial");
    assert.equal((result.run.result as any).issues[0].targetId, bad);
    assert.equal((result.run.result as any).generateImages[0].targetId, good);
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

test("an explicit current-track video-only request overrides a wrong planner action and uses the sole script track", options, async () => {
  const f = await fixture();
  try {
    await f.db("o_project").where({ id: f.projectId }).update({ mode: "text" });
    const [track] = await insertRowsReturningIds(f.db, "o_videoTrack", { projectId: f.projectId, scriptId: f.scriptId, duration: 4, prompt: "human prompt" });
    const [one, two] = await insertRowsReturningIds(f.db, "o_storyboard", [
      { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "one", videoDesc: "one", duration: "2", track: "A", trackId: track, shouldGenerateImage: 0, state: "未生成" },
      { projectId: f.projectId, scriptId: f.scriptId, index: 1, prompt: "two", videoDesc: "two", duration: "2", track: "A", trackId: track, shouldGenerateImage: 0, state: "未生成" },
    ]);
    const received: any[] = [];
    const modelCalls: string[] = [];
    const model = modelFor(() => { throw new Error("explicit video-only must not call planner"); }, modelCalls);
    const result = await runOnce(f, model, { generateVideo: async (input) => { received.push(input); return { status: "succeeded", jobId: "track-video" }; } }, { ...defaultBuiltinRunLimits, maxVideoGenerations: 1 }, "为当前轨道生成1条4秒视频，480p，无音频。沿用已保存并人工补充的视频提示词与现有分镜参考图，不出图、不重写分镜或导演计划。", async () => ({ mode: "text", resolution: "480p", audio: false }));
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    assert.equal(received.length, 1);
    assert.equal(received[0].targetId, track);
    assert.deepEqual(received[0].params.storyboardIds, [one, two]);
    assert.match(received[0].params.instructions, /人工补充的视频提示词/);
    assert.deepEqual(modelCalls, []);
    const persisted = await f.db("ext_builtin_runs").where({ id: result.run.id }).first();
    const planStep = await f.db("ext_builtin_run_steps").where({ runId: result.run.id, stepKey: "production.plan:r0" }).first();
    assert.equal(Number(persisted.modelCalls), 0);
    assert.equal(Boolean(planStep.modelCall), false);

    let plannerCalls = 0;
    const ordinary = await runOnce(f, modelFor((request) => { if (request.role === "productionAgent:decisionAgent") plannerCalls++; return { actions: [], assetIds: [], storyboardIds: [], question: null, summary: "nothing requested" }; }, []), undefined, defaultBuiltinRunLimits, "查看当前制作状态");
    assert.equal(ordinary.run.status, "succeeded", ordinary.run.errorMessage ?? "");
    assert.equal(plannerCalls, 1);
  } finally { await f.destroy(); }
});

test("video scope omission never expands to every track, and unknown or cross-script tracks fail closed", options, async () => {
  const f = await fixture();
  try {
    const [track] = await insertRowsReturningIds(f.db, "o_videoTrack", { projectId: f.projectId, scriptId: f.scriptId, duration: 2 });
    await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "one", duration: "2", track: "A", trackId: track, shouldGenerateImage: 0, state: "未生成" });
    let mediaCalls = 0;
    const media = { generateVideo: async () => { mediaCalls++; return { status: "succeeded", jobId: "must-not-run" }; } };
    const omitted = await runOnce(f, modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["generateVideos"], assetIds: [], storyboardIds: [], mediaInstructions: [], question: null, summary: "omitted" } : { items: [], summary: "" }, []), media, { ...defaultBuiltinRunLimits, maxVideoGenerations: 1 });
    assert.equal(omitted.run.status, "succeeded", omitted.run.errorMessage ?? "");
    assert.equal((omitted.run.result as any).outcome, "partial");
    assert.equal(mediaCalls, 0);

    const [emptyTrack] = await insertRowsReturningIds(f.db, "o_videoTrack", { projectId: f.projectId, scriptId: f.scriptId, duration: 2 });
    const unknown = await runOnce(f, modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["generateVideos"], assetIds: [], storyboardIds: [], mediaInstructions: [{ targetKind: "track", targetId: emptyTrack, instructions: "unknown" }], question: null, summary: "unknown" } : { items: [], summary: "" }, []), media, { ...defaultBuiltinRunLimits, maxVideoGenerations: 1 });
    assert.equal(unknown.run.status, "failed");
    assert.match(unknown.run.errorMessage ?? "", /不属于当前剧集分镜快照/);

    const [otherScript] = await insertRowsReturningIds(f.db, "o_script", { projectId: f.projectId, name: "other", content: "other" });
    const [otherTrack] = await insertRowsReturningIds(f.db, "o_videoTrack", { projectId: f.projectId, scriptId: otherScript, duration: 2 });
    await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: otherScript, index: 0, prompt: "foreign", duration: "2", track: "B", trackId: otherTrack, shouldGenerateImage: 0, state: "未生成" });
    const crossScript = await runOnce(f, modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["generateVideos"], assetIds: [], storyboardIds: [], mediaInstructions: [{ targetKind: "track", targetId: otherTrack, instructions: "cross" }], question: null, summary: "cross" } : { items: [], summary: "" }, []), media, { ...defaultBuiltinRunLimits, maxVideoGenerations: 1 });
    assert.equal(crossScript.run.status, "failed");
    assert.match(crossScript.run.errorMessage ?? "", /不属于当前剧集分镜快照/);
    assert.equal(mediaCalls, 0);

    const [secondLocalTrack] = await insertRowsReturningIds(f.db, "o_videoTrack", { projectId: f.projectId, scriptId: f.scriptId, duration: 2 });
    await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 1, prompt: "two", duration: "2", track: "C", trackId: secondLocalTrack, shouldGenerateImage: 0, state: "未生成" });
    const ambiguous = await runOnce(f, modelFor((request) => request.role === "productionAgent:decisionAgent" ? { actions: ["extractAssets"], assetIds: [], storyboardIds: [], mediaInstructions: [], question: null, summary: "wrong" } : { items: [], summary: "" }, []), media, { ...defaultBuiltinRunLimits, maxVideoGenerations: 1 }, "为当前轨道生成1条4秒视频");
    assert.equal(ambiguous.run.status, "failed");
    assert.match(ambiguous.run.errorMessage ?? "", /多个视频轨道/);
    assert.equal(mediaCalls, 0);
  } finally { await f.destroy(); }
});

test("scoped image instructions do not leak one storyboard's local request into another", options, async () => {
  const f = await fixture();
  try {
    const [first] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "first base", duration: "2", track: "A", videoDesc: "first desc", shouldGenerateImage: 1, state: "未生成" });
    const [second] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 1, prompt: "second base", duration: "3", track: "B", videoDesc: "second desc", shouldGenerateImage: 1, state: "未生成" });
    const received: any[] = [];
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent"
      ? { actions: ["generateImages"], assetIds: [], storyboardIds: [first, second], globalMediaInstructions: "统一冷色海底光线", mediaInstructions: [
          { targetKind: "storyboard", targetId: first, instructions: "S01 金爪海螺极特写" },
          { targetKind: "storyboard", targetId: second, instructions: "S06 九九反应特写" },
        ], question: null, summary: "images" }
      : { items: [], summary: "" }, []);
    const result = await runOnce(f, model, { generateImage: async (input) => { received.push(input); return { status: "succeeded", jobId: input.targetId }; } }, { ...defaultBuiltinRunLimits, maxImageGenerations: 2 });
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    const firstInstruction = received.find((item) => item.targetId === first).params.imageInstruction;
    const secondInstruction = received.find((item) => item.targetId === second).params.imageInstruction;
    assert.match(firstInstruction, /统一冷色海底光线/); assert.match(firstInstruction, /S01 金爪海螺极特写/); assert.doesNotMatch(firstInstruction, /S06 九九反应特写/);
    assert.match(secondInstruction, /统一冷色海底光线/); assert.match(secondInstruction, /S06 九九反应特写/); assert.doesNotMatch(secondInstruction, /S01 金爪海螺极特写/);
  } finally { await f.destroy(); }
});

test("scoped video instructions stay with their track target", options, async () => {
  const f = await fixture();
  try {
    const [trackA] = await insertRowsReturningIds(f.db, "o_videoTrack", { projectId: f.projectId, scriptId: f.scriptId, duration: 2 });
    const [trackB] = await insertRowsReturningIds(f.db, "o_videoTrack", { projectId: f.projectId, scriptId: f.scriptId, duration: 3 });
    const [first] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "first", duration: "2", track: "A", trackId: trackA, videoDesc: "first video", shouldGenerateImage: 0, state: "未生成" });
    const [second] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 1, prompt: "second", duration: "3", track: "B", trackId: trackB, videoDesc: "second video", shouldGenerateImage: 0, state: "未生成" });
    const received: any[] = [];
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent"
      ? { actions: ["generateVideos"], assetIds: [], storyboardIds: [first, second], globalMediaInstructions: "统一保留海浪环境声", mediaInstructions: [
          { targetKind: "storyboard", targetId: first, instructions: "S01 海螺微距" },
          { targetKind: "storyboard", targetId: second, instructions: "S06 九九反应特写" },
        ], question: null, summary: "videos" }
      : { items: [], summary: "" }, []);
    const result = await runOnce(f, model, { generateVideo: async (input) => { received.push(input); return { status: "succeeded", jobId: input.targetId }; } }, { ...defaultBuiltinRunLimits, maxVideoGenerations: 2 }, "produce", async () => ({ mode: "text", resolution: "720p", audio: true }));
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    const firstPrompt = received.find((item) => item.targetId === trackA).params.prompt;
    const secondPrompt = received.find((item) => item.targetId === trackB).params.prompt;
    assert.match(firstPrompt, /统一保留海浪环境声/); assert.match(firstPrompt, /S01 海螺微距/); assert.doesNotMatch(firstPrompt, /S06 九九反应特写/);
    assert.match(secondPrompt, /统一保留海浪环境声/); assert.match(secondPrompt, /S06 九九反应特写/); assert.doesNotMatch(secondPrompt, /S01 海螺微距/);
  } finally { await f.destroy(); }
});

test("media instructions for foreign or unselected targets fail before media calls", options, async () => {
  const f = await fixture();
  try {
    const [selected] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "selected", duration: "2", track: "A", shouldGenerateImage: 1, state: "未生成" });
    const [foreignProject] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Foreign" });
    const [foreignScript] = await insertRowsReturningIds(f.db, "o_script", { projectId: foreignProject, name: "Foreign episode", content: "" });
    const [foreign] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: foreignProject, scriptId: foreignScript, index: 0, prompt: "foreign", duration: "2", track: "X", shouldGenerateImage: 1, state: "未生成" });
    let mediaCalls = 0;
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent"
      ? { actions: ["generateImages"], assetIds: [], storyboardIds: [selected], globalMediaInstructions: "shared", mediaInstructions: [{ targetKind: "storyboard", targetId: foreign, instructions: "must not apply" }], question: null, summary: "invalid" }
      : { items: [], summary: "" }, []);
    const result = await runOnce(f, model, { generateImage: async () => { mediaCalls++; return { status: "succeeded", jobId: 1 }; } }, { ...defaultBuiltinRunLimits, maxImageGenerations: 1 });
    assert.equal(result.run.status, "failed");
    assert.equal(mediaCalls, 0);
    assert.match(result.run.errorMessage ?? "", /局部要求目标/);
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

test("rerunning existing storyboard IDs preserves their track bindings and does not create duplicate tracks", options, async () => {
  const f = await fixture();
  try {
    const existing: Array<{ id: number; trackId: number; version: number }> = [];
    for (let index = 0; index < 18; index++) {
      const [trackId] = await insertRowsReturningIds(f.db, "o_videoTrack", { projectId: f.projectId, scriptId: f.scriptId, duration: 2, prompt: `human track prompt ${index}` });
      const [storyboardId] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index, prompt: `old ${index}`, duration: "2", track: `old-track-${index}`, trackId, videoDesc: `old desc ${index}`, shouldGenerateImage: 0, state: "未生成" });
      const state = await new ProductionStateService(f.db).getStoryboardState(f.projectId, storyboardId);
      existing.push({ id: storyboardId, trackId, version: state.state.version });
    }
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent"
      ? { actions: ["storyboard"], assetIds: [], storyboardIds: existing.map((item) => item.id), question: null, summary: "rerun" }
      : { items: existing.map((item, index) => ({ id: item.id, expectedVersion: item.version, prompt: `updated ${index}`, duration: 2, track: `model-renamed-${index}`, videoDesc: `updated desc ${index}`, shouldGenerateImage: 0, associateAssetsIds: [f.assetId] })), summary: "rerun" }, []);
    const result = await runOnce(f, model);
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    const tracks = await f.db("o_videoTrack").where({ projectId: f.projectId, scriptId: f.scriptId });
    assert.equal(tracks.length, 18);
    for (const item of existing) {
      const saved = await f.db("o_storyboard").where({ id: item.id }).first();
      assert.equal(Number(saved.trackId), item.trackId);
      assert.equal((await f.db("o_videoTrack").where({ id: item.trackId }).first()).prompt, `human track prompt ${existing.indexOf(item)}`);
    }
  } finally { await f.destroy(); }
});

test("a new storyboard without a track creates exactly one new track", options, async () => {
  const f = await fixture();
  try {
    const before = await f.db("o_videoTrack").where({ projectId: f.projectId, scriptId: f.scriptId });
    const model = modelFor((request) => request.role === "productionAgent:decisionAgent"
      ? { actions: ["storyboard"], assetIds: [], storyboardIds: [], question: null, summary: "new" }
      : { items: [{ id: null, prompt: "new shot", duration: 3, track: "new-track", videoDesc: "new desc", shouldGenerateImage: 0, associateAssetsIds: [f.assetId], expectedVersion: null }], summary: "new" }, []);
    const result = await runOnce(f, model);
    assert.equal(result.run.status, "succeeded", result.run.errorMessage ?? "");
    const after = await f.db("o_videoTrack").where({ projectId: f.projectId, scriptId: f.scriptId });
    assert.equal(after.length, before.length + 1);
    assert.equal((await f.db("o_storyboard").where({ projectId: f.projectId, scriptId: f.scriptId })).length, 1);
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

test("missing production information ends with a clear error instead of waiting for a chat reply", options, async () => {
  const f = await fixture();
  try {
    const model = modelFor(() => ({ actions: [], assetIds: [], storyboardIds: [], question: "Which episode?", summary: "need information" }), []);
    const result = await runOnce(f, model);
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.errorCode, "INVALID_INPUT");
    assert.equal((await f.db("ext_builtin_runs").where({ id: result.run.id }).first()).waitingQuestion, null);
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

test('format retry is budgeted and does not repeat saved planning', options, async()=>{
 const f=await fixture();let reviews=0,plans=0;
 try{
  const model=modelFor(req=>{
   if(req.role==='productionAgent:decisionAgent')return{actions:['planning','review'],assetIds:[],storyboardIds:[],question:null,summary:'plan and review'};
   if(req.role==='productionAgent:directorPlanAgent'){plans++;return{scriptPlan:'Only one committed plan'};}
   reviews++;if(reviews===1)throw new StructuredModelOutputError('MODEL_OUTPUT_FORMAT',{role:req.role,finishReason:'stop',maxOutputTokens:4000,textCharacters:120,outputTokens:20});
   assert.match(req.system,/上次输出未通过 JSON/);return{findings:[],summary:'review passed'};
  },[]);
  const result=await runOnce(f,model);
  assert.equal(result.run.status,'succeeded',result.run.errorMessage??'');assert.equal(plans,1);assert.equal(reviews,2);assert.equal(result.run.modelCalls,4);
  const saved=await f.db('o_agentWorkData').where({projectId:f.projectId,key:'productionAgent'});assert.equal(saved.length,1);assert.equal(JSON.parse(saved[0].data).planningVersion,1);
  const retry=await f.db('ext_builtin_run_steps').where({runId:result.run.id,stepKey:'production.review.formatRetry:r0'}).first();assert.equal(retry.status,'completed');assert.equal(retry.modelCall,true);
 }finally{await f.destroy();}
});

test('derived-only commands override a planner that targets roots and preserve root images', options, async()=>{
 const f=await fixture();const targets:number[]=[];
 try{
  const [oldImage]=await insertRowsReturningIds(f.db,'o_image',{assetsId:f.assetId,state:'已完成',filePath:'/old-root.jpg',type:'role'});await f.db('o_assets').where({id:f.assetId}).update({imageId:oldImage});
  const model=modelFor(req=>req.role==='productionAgent:decisionAgent'?{actions:['generateImages','storyboard'],assetIds:[f.assetId],storyboardIds:[],question:'Which asset?',summary:'wrong plan'}:{assets:[{parentAssetId:f.assetId,id:null,expectedVersion:null,name:'Wet variant',description:'Same hero after rain'}]},[]);
  const result=await runOnce(f,model,{generateImage:async req=>{targets.push(req.targetId);return{status:'succeeded',jobId:1,selected:true}}},{...defaultBuiltinRunLimits,maxImageGenerations:1},'生产衍生资产');
  assert.equal(result.run.status,'succeeded',result.run.errorMessage??'');const child=await f.db('o_assets').where({assetsId:f.assetId}).first();assert.ok(child);assert.deepEqual(targets,[Number(child.id)]);assert.equal(Number((await f.db('o_assets').where({id:f.assetId}).first()).imageId),oldImage);assert.equal((await f.db('o_storyboard').where({projectId:f.projectId})).length,0);
 }finally{await f.destroy();}
});
test('empty derived analysis and full production never fall back to regenerating completed roots', options, async()=>{
 for(const prompt of ['生成全部衍生资产','全部生成']){const f=await fixture();let images=0;try{
  const [oldImage]=await insertRowsReturningIds(f.db,'o_image',{assetsId:f.assetId,state:'已完成',filePath:'/old-root.jpg',type:'role'});await f.db('o_assets').where({id:f.assetId}).update({imageId:oldImage});
  const model=modelFor(req=>req.role==='productionAgent:decisionAgent'?{actions:['generateImages'],assetIds:[f.assetId],storyboardIds:[],question:null,summary:'all'}:{assets:[]},[]);
  const result=await runOnce(f,model,{generateImage:async()=>{images++;return{status:'succeeded',jobId:1}}},defaultBuiltinRunLimits,prompt);assert.equal(result.run.status,'succeeded',result.run.errorMessage??'');assert.equal(images,0);assert.equal(Number((await f.db('o_assets').where({id:f.assetId}).first()).imageId),oldImage);
 }finally{await f.destroy();}}
});
