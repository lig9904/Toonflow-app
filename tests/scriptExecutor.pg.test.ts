import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureCreativeWorkspaceSchema, readScriptWorkspace, saveScriptWorkspace } from "../src/services/creativeWorkspace";
import { BuiltinAgentRuntime, ensureBuiltinAgentRuntimeSchema } from "../src/services/builtinAgentRuntime";
import { createScriptAgentExecutor, type StructuredScriptModel } from "../src/services/builtinAgent/scriptExecutor";
import { defaultBuiltinRunLimits } from "../src/services/builtinAgent/contracts";
import { ensureAssetExtractionWorkspaceSchema } from "../src/services/assetExtractionWorkspace";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };

test("a new script feeds its actual ID into asset extraction and the reviewer sees the committed bindings", options, async () => {
  const f = await fixture();
  await ensureAssetExtractionWorkspaceSchema(f.db);
  const roles: string[] = [];
  let extractedScriptId = 0;
  try {
    const model: StructuredScriptModel = { async generate(req) {
      roles.push(req.role);
      let value: unknown;
      if (req.role === "scriptAgent:decisionAgent") value = { actions: ["script", "extractAssets", "review"], chapterIds: [], targetScriptIds: [], question: null, summary: "Script and assets" };
      else if (req.role === "scriptAgent:scriptAgent") value = { script: [{ id: null, name: "Episode", content: "A guide walks along the beach.", assets: [] }], summary: "Created" };
      else if (req.role === "universalAi") {
        const input = req.input as any;
        extractedScriptId = input.scripts[0].id;
        assert(extractedScriptId > 0); assert.equal(input.scripts[0].content, "A guide walks along the beach.");
        value = { roles: [{ action: "create", key: "guide", name: "Guide", description: "Beach guide", prompt: "Guide in blue" }], scenes: [], props: [], bindings: [{ scriptId: extractedScriptId, assets: [{ kind: "created", key: "guide" }] }], summary: "Extracted" };
      } else {
        const workspace = (req.input as any).workspace;
        assert.equal(workspace.script[0].assets.length, 1);
        assert.equal(workspace.version, 2);
        value = { findings: [], summary: "Reviewed committed assets" };
      }
      return { value: req.schema.parse(value), outputTokens: 5 };
    } };
    const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: createScriptAgentExecutor({ db: f.db, model, loadSkill: async () => "fixture" }) });
    const created = await runtime.create({ agentType: "scriptAgent", projectId: f.projectId, requestedBy: 1, prompt: "Write an episode and extract assets", idempotencyKey: "script-asset-chain", limits: defaultBuiltinRunLimits });
    await runtime.runOnce();
    const run = await runtime.get(created.run.id);
    assert.equal(run.status, "succeeded", run.errorMessage ?? "");
    assert.deepEqual(roles, ["scriptAgent:decisionAgent", "scriptAgent:scriptAgent", "universalAi", "scriptAgent:supervisionAgent"]);
    const workspace = await readScriptWorkspace(f.db, f.projectId);
    assert.equal(workspace.script[0].id, extractedScriptId);
    assert.equal(workspace.script[0].assets.length, 1);
    assert.equal((run.result as any).version, workspace.version);
  } finally { await f.destroy(); }
});
async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureCreativeWorkspaceSchema(f.db);
  await ensureBuiltinAgentRuntimeSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Creative project", projectType: "script" });
  return { ...f, projectId };
}

test("builtin script roles save structured artifacts without a browser or XML callback", options, async () => {
  const f = await fixture();
  try {
    const called: string[] = [];
    const model: StructuredScriptModel = { async generate(req) {
      called.push(req.role);
      let value: unknown;
      if (req.role === "scriptAgent:decisionAgent") value = { actions: ["script", "storySkeleton", "adaptationStrategy", "review"], chapterIds: [], targetScriptIds: [], question: null, summary: "开始创作" };
      else if (req.role === "scriptAgent:storySkeletonAgent") value = { content: "The skeleton" };
      else if (req.role === "scriptAgent:adaptationStrategyAgent") value = { content: "The strategy" };
      else if (req.role === "scriptAgent:scriptAgent") {
        assert.equal((req.input as any).proposal.storySkeleton, "The skeleton");
        value = { script: [{ id: null, name: "Episode 1", content: "Structured script", assets: [] }], summary: "Written" };
      } else value = { findings: ["Check the chosen ending"], summary: "Review done" };
      return { value: req.schema.parse(value), outputTokens: 10 };
    } };
    const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async () => {}, execute: createScriptAgentExecutor({ db: f.db, model, loadSkill: async (name) => "Fixture skill: " + name }) });
    const { run } = await runtime.create({ agentType: "scriptAgent", projectId: f.projectId, requestedBy: 1, prompt: "Write a one episode story", idempotencyKey: "structured-script-run", limits: defaultBuiltinRunLimits });
    await runtime.runOnce();
    const final = await runtime.get(run.id);
    assert.equal(final.status, "succeeded", final.errorMessage ?? "");
    const workspace = await readScriptWorkspace(f.db, f.projectId);
    assert.equal(workspace.script.length, 1);
    assert.equal(workspace.script[0].content, "Structured script");
    assert.equal(workspace.storySkeleton, "The skeleton");
    assert.equal(workspace.adaptationStrategy, "The strategy");
    assert.deepEqual(called, ["scriptAgent:decisionAgent", "scriptAgent:storySkeletonAgent", "scriptAgent:adaptationStrategyAgent", "scriptAgent:scriptAgent", "scriptAgent:supervisionAgent"]);
    const artifacts = (await runtime.events(run.id)).filter((e) => e.type === "artifact.saved");
    assert.equal(artifacts.length, 1);
    assert.equal(await runtime.runOnce(), false);
    assert.equal(called.length, 5);
  } finally { await f.destroy(); }
});

test("unresolved script scope ends clearly without creating a human checkpoint or claiming completion", options, async () => {
  const f = await fixture();
  try {
    const model: StructuredScriptModel = { async generate(req) { return { value: req.schema.parse({ actions: [], chapterIds: [], targetScriptIds: [], question: "需要使用哪一集？", summary: "" }), outputTokens: 8 }; } };
    const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async () => {}, execute: createScriptAgentExecutor({ db: f.db, model, loadSkill: async () => "test" }) });
    const { run } = await runtime.create({ agentType: "scriptAgent", projectId: f.projectId, requestedBy: 1, prompt: "edit that one", idempotencyKey: "human-checkpoint-run", limits: defaultBuiltinRunLimits });
    await runtime.runOnce();
    assert.equal((await runtime.get(run.id)).status, "failed");
    assert.match((await runtime.get(run.id)).errorMessage ?? "", /需要使用哪一集/);
    assert.equal((await readScriptWorkspace(f.db, f.projectId)).version, 0);
  } finally { await f.destroy(); }
});

test("human edits during model work reject the whole stale generated workspace", options, async () => {
  const f = await fixture();
  try {
    const first = await saveScriptWorkspace(f.db, { projectId: f.projectId, expectedVersion: 0, actor: { id: "human:1", kind: "human" }, mutationKey: "initial-human-script", script: [{ name: "Episode", content: "Before" }] });
    const id = first.script[0].id;
    const model: StructuredScriptModel = { async generate(req) {
      if (req.role === "scriptAgent:decisionAgent") return { value: req.schema.parse({ actions: ["script"], chapterIds: [], targetScriptIds: [id], question: null, summary: "Edit" }), outputTokens: 8 };
      await saveScriptWorkspace(f.db, { projectId: f.projectId, expectedVersion: 1, actor: { id: "human:1", kind: "human" }, mutationKey: "new-human-edit", script: [{ id, expectedVersion: 1, name: "Episode", content: "Human wins" }] });
      return { value: req.schema.parse({ script: [{ id, name: "Episode", content: "Stale model", assets: null }], summary: "" }), outputTokens: 8 };
    } };
    const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async () => {}, execute: createScriptAgentExecutor({ db: f.db, model, loadSkill: async () => "test" }) });
    const { run } = await runtime.create({ agentType: "scriptAgent", projectId: f.projectId, requestedBy: 1, prompt: "Edit the episode", idempotencyKey: "stale-generated-script", limits: defaultBuiltinRunLimits });
    await runtime.runOnce();
    assert.notEqual((await runtime.get(run.id)).status, "succeeded");
    assert.equal((await readScriptWorkspace(f.db, f.projectId)).script[0].content, "Human wins");
    assert.equal((await runtime.events(run.id)).filter((e) => e.type === "artifact.saved").length, 0);
  } finally { await f.destroy(); }
});

test("run prompt snapshots survive pause and takeover revisions while a new run uses edited skill and common rules", options, async () => {
  for (const control of ["pause", "takeover"] as const) {
    const f = await fixture(); let release: (() => void) | undefined;
    try {
      await ensureAssetExtractionWorkspaceSchema(f.db);
      const initial = await saveScriptWorkspace(f.db, { projectId: f.projectId, expectedVersion: 0, actor: { id: "human:1", kind: "human" }, mutationKey: `snapshot-script-${control}`, script: [{ name: "Episode", content: "A still scene" }] });
      const scriptId = initial.script[0].id;
      await f.db("o_prompt").where({ type: "scriptAssetExtraction" }).update({ useData: "COMMON-V1" });
      let skillVersion = "SKILL-V1", loads = 0, skeletonCalls = 0;
      const systems: Array<{ role: string; system: string }> = [];
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const model: StructuredScriptModel = { async generate(req) {
        systems.push({ role: req.role, system: req.system });
        let value: unknown;
        if (req.role === "scriptAgent:decisionAgent") value = { actions: ["storySkeleton", "extractAssets"], chapterIds: [], targetScriptIds: [scriptId], question: null, summary: "Update skeleton and extract" };
        else if (req.role === "scriptAgent:storySkeletonAgent") {
          skeletonCalls += 1; if (skeletonCalls === 1) { entered(); await blocked; }
          value = { content: "Skeleton generated with frozen rules" };
        } else value = { roles: [], scenes: [], props: [], bindings: [{ scriptId, assets: [] }], summary: "No assets required" };
        return { value: req.schema.parse(value), outputTokens: 5 };
      } };
      const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: createScriptAgentExecutor({ db: f.db, model, loadSkill: async (name) => { loads += 1; return `${skillVersion}:${name}`; } }) });
      const created = await runtime.create({ agentType: "scriptAgent", projectId: f.projectId, requestedBy: 1, prompt: "Update skeleton and extract existing episode", idempotencyKey: `prompt-snapshot-${control}`, limits: defaultBuiltinRunLimits });
      const running = runtime.runOnce();
      await Promise.race([waiting, running.then(() => { throw new Error("Stopped before the pending skeleton"); })]);
      skillVersion = "SKILL-V2";
      await f.db("o_prompt").where({ type: "scriptAssetExtraction" }).update({ useData: "COMMON-V2" });
      const current = await runtime.get(created.run.id);
      const stopped = await runtime.control(current.id, current.version, control);
      release!(); await running;
      const resumed = await runtime.control(current.id, stopped.version, "resume");
      assert.equal(resumed.inputRevision, control === "takeover" ? 1 : 0);
      await runtime.runOnce();
      const completed = await runtime.get(created.run.id);
      assert.equal(completed.status, "succeeded", completed.errorMessage ?? "");
      assert.equal(loads, 5, "the resumed run must not reload any skill");
      assert(systems.filter((item) => item.role !== "universalAi").every((item) => item.system.includes("SKILL-V1")));
      assert(systems.filter((item) => item.role === "universalAi").every((item) => item.system.includes("COMMON-V1")));
      const snapshotRows = await f.db("ext_builtin_run_steps").where({ runId: created.run.id, stepKey: "script.promptSnapshot" });
      assert.equal(snapshotRows.length, 1); assert.equal(snapshotRows[0].attempt, 1); assert.equal(snapshotRows[0].modelCall, false);
      assert.equal(completed.modelCalls, control === "takeover" ? 5 : 4);
      assert.equal(completed.imageGenerations, 0); assert.equal(completed.videoGenerations, 0);
      const beforeNew = systems.length;
      const next = await runtime.create({ agentType: "scriptAgent", projectId: f.projectId, requestedBy: 1, prompt: "Update skeleton and extract existing episode", idempotencyKey: `prompt-snapshot-${control}-new`, limits: defaultBuiltinRunLimits });
      await runtime.runOnce();
      assert.equal((await runtime.get(next.run.id)).status, "succeeded");
      assert.equal(loads, 10);
      assert(systems.slice(beforeNew).filter((item) => item.role !== "universalAi").every((item) => item.system.includes("SKILL-V2")));
      assert(systems.slice(beforeNew).filter((item) => item.role === "universalAi").every((item) => item.system.includes("COMMON-V2")));
    } finally { release?.(); await f.destroy(); }
  }
});
