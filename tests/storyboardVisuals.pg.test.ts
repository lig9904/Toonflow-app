import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureProductionStateSchema, ProductionStateService } from "../src/services/productionState";
import { ensureCreativeWorkspaceSchema } from "../src/services/creativeWorkspace";
import { BuiltinAgentRuntime, ensureBuiltinAgentRuntimeSchema } from "../src/services/builtinAgentRuntime";
import { createImageGenerationService } from "../src/services/imageJobs/runtime";
import { prepareStoryboardImages } from "../src/services/productionImages";
import { createProductionAgentExecutor } from "../src/services/builtinAgent/productionExecutor";
import { createProductionMediaCapabilities } from "../src/services/builtinAgent/media";
import { defaultBuiltinRunLimits } from "../src/services/builtinAgent/contracts";
import { reconcileStoredStoryboardReferences } from "../src/services/storyboardVisuals";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const prompt = "古港海岸，灵兽抱臂别过头，眼角偷偷瞥向海螺，对白：『我已知道。它……今天安静。』，雪璃压住笑声。";
const guide = "| **Seedance 2.0（中文）** | `国风二次元动画，赛璐璐平涂` |";

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db); await ensureProductionStateSchema(f.db); await ensureCreativeWorkspaceSchema(f.db); await ensureBuiltinAgentRuntimeSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Visual contract", imageModel: "mock:image", imageQuality: "2K", videoRatio: "9:16", artStyle: "2D_chinese_guofeng" });
  const [scriptId] = await insertRowsReturningIds(f.db, "o_script", { projectId, name: "Episode", content: prompt });
  const ids: number[] = [];
  for (const [name, type, describe] of [["灵兽", "role", "非人类的螭吻神兽"], ["海螺", "tool", "珍珠白海螺"], ["古港海岸", "scene", "清晨海岸"], ["雪璃", "role", "狐族年轻成年女性，银白长发，红白金服饰"]]) {
    const [id] = await insertRowsReturningIds(f.db, "o_assets", { projectId, name, type, describe });
    const [imageId] = await insertRowsReturningIds(f.db, "o_image", { assetsId: id, type: "role", state: "已完成", filePath: `/${projectId}/assets/ref-${id}.jpg` });
    await f.db("o_assets").where({ id }).update({ imageId }); await f.db("o_scriptAssets").insert({ scriptId, assetId: id }); ids.push(id);
  }
  const boards: number[] = [];
  for (let index = 0; index < 2; index++) {
    const [id] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId, scriptId, index, track: `S0${index + 1}`, prompt, videoDesc: "特写反应，嘴硬心虚。", duration: "3", state: "未生成", shouldGenerateImage: 1 });
    await f.db("o_assets2Storyboard").insert(ids.slice(0, 3).map((assetId) => ({ storyboardId: id, assetId }))); boards.push(id);
  }
  const submitted: any[] = [];
  const provider = { fingerprint: "mock-visual", submit: async (config: unknown) => { submitted.push(config); return { taskId: `task-${submitted.length}` }; }, query: async () => ({ status: "succeeded" as const, outputUrl: "https://fixture.invalid/result.jpg" }) };
  const jobs = createImageGenerationService({ db: f.db, providerFor: async () => provider, download: async () => undefined, pollMs: 10 });
  const getImageBase64 = async (file: string) => `data:image/jpeg;base64,${Buffer.from(file).toString("base64")}`;
  return { ...f, projectId, scriptId, ids, boards, submitted, jobs, getImageBase64 };
}

test("panel and builtin generation use the same repaired identities and visual prompt", options, async () => {
  const f = await fixture();
  try {
    const panel = await prepareStoryboardImages(f.db, { projectId: f.projectId, scriptId: f.scriptId, storyboardIds: [f.boards[0]], runtime: {
      imageJobs: f.jobs, getArtPrompt: () => guide, generatePrompt: async () => "unused", getImageBase64: f.getImageBase64, getSmallImageUrl: async (file) => file, uuid: () => "panel-visual",
    } });
    await panel.run();
    const media = createProductionMediaCapabilities({ db: f.db, images: f.jobs, videos: {} as any,
      imageModelFor: async (key) => ({ key, modelName: "image", type: "image", mode: ["multiReference"] }), modelFor: async () => ({}), videoProviderFor: async () => { throw new Error("No video"); },
      toBase64: f.getImageBase64, visualStyleGuide: () => guide,
    });
    const agent = new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: createProductionAgentExecutor({ db: f.db, media, loadSkill: async () => "fixture", model: {
      async generate(request) { return { value: request.schema.parse({ actions: ["generateImages"], assetIds: [], storyboardIds: [f.boards[1]], question: null, summary: "generate" }), outputTokens: 5 }; },
    } }) });
    const created = await agent.create({ agentType: "productionAgent", projectId: f.projectId, scriptId: f.scriptId, requestedBy: 1, prompt: "generate", idempotencyKey: "builtin-visual-parity", limits: { ...defaultBuiltinRunLimits, maxImageGenerations: 1 } });
    await agent.runOnce();
    const run = await agent.get(created.run.id);
    assert.equal(run.status, "succeeded", run.errorMessage ?? "");
    assert.equal(f.submitted.length, 2);
    assert.deepEqual(f.submitted[0], { ...f.submitted[1], prompt: f.submitted[1].prompt.replace(/\n本次画面调整：[^\n]*/, "") });
    assert.equal(f.submitted[0].referenceList.length, 4);
    assert.match(f.submitted[0].prompt, /参考图4（@图4）=雪璃：狐族年轻成年女性/);
    assert.match(f.submitted[0].prompt, /特写反应/); assert.doesNotMatch(f.submitted[0].prompt, /我已知道|今天安静/);
    for (const id of f.boards) {
      assert.equal((await f.db("o_assets2Storyboard").where({ storyboardId: id })).length, 4);
      assert.equal((await f.db("o_storyboard").where({ id }).first()).prompt, prompt, "Stored dialogue and author text must not be rewritten by image preparation");
    }
    await agent.stop();
  } finally { f.jobs.stop(); await f.destroy(); }
});

test("a reference identity changed during generation prevents automatic selection", options, async () => {
  const f = await fixture();
  try {
    const prepared = await prepareStoryboardImages(f.db, { projectId: f.projectId, scriptId: f.scriptId, storyboardIds: [f.boards[0]], runtime: {
      imageJobs: f.jobs, getArtPrompt: () => guide, generatePrompt: async () => "unused", getImageBase64: f.getImageBase64, getSmallImageUrl: async (file) => file, uuid: () => "identity-change",
    } });
    // The provider still renders the immutable request, but this human edit
    // means its old identity context must no longer replace the canvas.
    await f.db("o_assets").where({ id: f.ids[3] }).update({ describe: "Human revised identity" });
    await prepared.run();
    const binding = await f.db("ext_image_job_bindings").where({ targetId: String(f.boards[0]) }).first();
    assert.equal(binding.selected, false); assert.equal(binding.state, "SUCCEEDED"); assert.ok(binding.artifactPath);
    assert.equal((await f.db("o_storyboard").where({ id: f.boards[0] }).first()).filePath, null);
  } finally { f.jobs.stop(); await f.destroy(); }
});

test("stale or locked canvas versions cannot be auto-repaired", options, async () => {
  const f = await fixture();
  try {
    const id = f.boards[0];
    const state = await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: id }).first();
    await new ProductionStateService(f.db).updateStoryboardContent({ projectId: f.projectId, storyboardId: id, expectedVersion: Number(state.version), actor: { kind: "human", id: "human:1" }, patch: { prompt: "Only a landscape" } });
    await assert.rejects(reconcileStoredStoryboardReferences(f.db, { projectId: f.projectId, scriptId: f.scriptId, storyboardIds: [id], expectedVersions: { [id]: Number(state.version) } }), /旧请求已停止/);
    assert.equal((await f.db("o_assets2Storyboard").where({ storyboardId: id })).length, 3);
    const second = f.boards[1]; await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: second }).update({ locked: 1 });
    await assert.rejects(reconcileStoredStoryboardReferences(f.db, { projectId: f.projectId, scriptId: f.scriptId, storyboardIds: [second] }), /锁定分镜/);
    assert.equal(f.submitted.length, 0);
  } finally { f.jobs.stop(); await f.destroy(); }
});
