import assert from "node:assert/strict";
import test from "node:test";
import type { Knex } from "knex";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureProductionStateSchema, ProductionStateService } from "../src/services/productionState";
import { createImageGenerationService, ensureProductionImageJobSchema, resolveImageArtifactProject, type ImageGenerationService } from "../src/services/imageJobs/runtime";
import type { PersistentAsyncImageTaskProvider } from "../src/lib/persistentImageAdapter";
import { generateRootAssetImage } from "../src/services/rootAssetImages";
import { prepareDerivedAssetImages, prepareStoryboardImages, type ProductionImageRuntime } from "../src/services/productionImages";
import { generateFlowImage } from "../src/services/productionEditImages";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };

test("missing reference images reject the whole batch before reserving any storyboard", options, async () => {
  const f = await fixture();
  try {
    const missing = await asset(f, { name: "Unrendered derived asset" });
    const [one, two] = await insertRowsReturningIds(f.db, "o_storyboard", [{ projectId: f.projectId, scriptId: f.scriptId, prompt: "one", state: "未生成", shouldGenerateImage: 1 }, { projectId: f.projectId, scriptId: f.scriptId, prompt: "two", state: "未生成", shouldGenerateImage: 1 }]);
    await f.db("o_assets2Storyboard").insert({ storyboardId: two, assetId: missing });
    const log = { submits: [] as unknown[], queries: [] as string[] };
    const service = jobs(f.db, provider(log));
    const runtime: ProductionImageRuntime = { imageJobs: service, getArtPrompt: () => "", generatePrompt: async () => "", getImageBase64: async () => "", getSmallImageUrl: async (path) => path, uuid: () => "missing" };
    await assert.rejects(prepareStoryboardImages(f.db, { projectId: f.projectId, scriptId: f.scriptId, storyboardIds: [one, two], compulsory: true, runtime }), /Unrendered derived asset/);
    assert.equal((await f.db("ext_image_jobs")).length, 0);
    assert((await f.db("o_storyboard").whereIn("id", [one, two])).every((row) => row.state === "未生成"));
    assert.equal(log.submits.length, 0);
  } finally { await f.destroy(); }
});

test("a late batch preparation failure releases earlier unsubmitted reservations", options, async () => {
  const f = await fixture();
  try {
    const [one, two] = await insertRowsReturningIds(f.db, "o_storyboard", [{ projectId: f.projectId, scriptId: f.scriptId, prompt: "one", state: "未生成", shouldGenerateImage: 1 }, { projectId: f.projectId, scriptId: f.scriptId, prompt: "two", state: "未生成", shouldGenerateImage: 1 }]);
    const log = { submits: [] as unknown[], queries: [] as string[] };
    let prepared = 0;
    const service = createImageGenerationService({ db: f.db, providerFor: async () => provider(log), download: async () => undefined, validateConfig: () => { if (++prepared === 2) throw new Error("Second target rejected"); } });
    const runtime: ProductionImageRuntime = { imageJobs: service, getArtPrompt: () => "", generatePrompt: async () => "", getImageBase64: async () => "", getSmallImageUrl: async (path) => path, uuid: () => "cancel" };
    await assert.rejects(prepareStoryboardImages(f.db, { projectId: f.projectId, scriptId: f.scriptId, storyboardIds: [one, two], compulsory: true, runtime }), /Second target rejected/);
    assert.equal((await f.db("ext_image_jobs").first()).status, "FAILED");
    assert((await f.db("o_storyboard").whereIn("id", [one, two])).every((row) => row.state !== "生成中"));
    assert.equal(log.submits.length, 0);
  } finally { await f.destroy(); }
});

test("unsupported Seedream size fails before claiming a target or contacting the provider", options, async () => {
  const { validateImageOutputSize } = await import("../src/lib/imageRequestCapabilities");
  const f = await fixture();
  try {
    const targetId = await asset(f);
    const log = { submits: [] as unknown[], queries: [] as string[] };
    const service = createImageGenerationService({ db: f.db, providerFor: async () => provider(log), download: async () => undefined, validateConfig: (key, config) => validateImageOutputSize(key, config.size) });
    await assert.rejects(service.prepare({ projectId: f.projectId, generationKey: "bad-image-size", modelKey: "zhenzhenRelay:seedream-v5-pro-i2i", config: { prompt: "image", size: "4K", aspectRatio: "9:16" }, target: { kind: "asset", id: targetId } }), /1K\/2K/);
    assert.equal((await f.db("ext_image_jobs")).length, 0); assert.equal(log.submits.length, 0);
    assert.equal((await f.db("o_assets").where({ id: targetId }).first()).imageId, null);
  } finally { await f.destroy(); }
});

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureProductionStateSchema(f.db);
  await ensureProductionImageJobSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { name: "image integration", userId: 1, imageModel: "zhenzhen:seedream-v5", imageQuality: "1K", videoRatio: "16:9", artStyle: "ink" });
  const [otherProjectId] = await insertRowsReturningIds(f.db, "o_project", { name: "other", userId: 2, imageModel: "zhenzhen:seedream-v5", imageQuality: "1K", videoRatio: "16:9" });
  const [scriptId] = await insertRowsReturningIds(f.db, "o_script", { projectId, name: "episode" });
  return { ...f, projectId, otherProjectId, scriptId };
}

function provider(log: { submits: unknown[]; queries: string[] }, status: "succeeded" | "pending" = "succeeded"): PersistentAsyncImageTaskProvider {
  return {
    fingerprint: "seedream-relay-v1",
    submit: async (config) => { log.submits.push(config); return { taskId: `upstream-${log.submits.length}` }; },
    query: async (taskId) => { log.queries.push(taskId); return status === "pending" ? { status } : { status, outputUrl: `https://relay.invalid/${taskId}.jpg` }; },
  };
}

function jobs(db: Knex, p: PersistentAsyncImageTaskProvider, downloads: string[] = []): ImageGenerationService {
  return createImageGenerationService({ db, providerFor: async () => p, download: async (url, path) => { downloads.push(`${url}|${path}`); }, uuid: () => "fixed-output", pollMs: 10 });
}

async function asset(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  const [id] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, name: "hero", type: "role", describe: "hero source", ...overrides });
  await f.db("o_scriptAssets").insert({ scriptId: f.scriptId, assetId: id });
  return id;
}

test("root assets use one durable job, preserve real candidate IDs, and reject changed retry payload", options, async () => {
  const f = await fixture();
  try {
    const targetId = await asset(f);
    const log = { submits: [] as unknown[], queries: [] as string[] };
    const service = jobs(f.db, provider(log));
    const input = { projectId: f.projectId, assetId: targetId, type: "role" as const, name: "hero", prompt: "red coat", model: "zhenzhen:seedream-v5", resolution: "1K", generationKey: "root-asset-stable-key", expectedVersion: 0 };
    const first = await generateRootAssetImage(f.db, service, input);
    const second = await generateRootAssetImage(f.db, service, input);
    assert.equal(first.status, "succeeded");
    assert.equal(second.jobId, first.jobId);
    assert.equal(log.submits.length, 1);
    const target = await f.db("o_assets").where({ id: targetId }).first();
    const candidate = await f.db("o_image").where({ id: target.imageId, assetsId: targetId }).first();
    assert.equal(candidate.state, "已完成");
    assert.equal(candidate.filePath, first.artifactPath);
    assert(Number(candidate.id) > 0);
    await assert.rejects(generateRootAssetImage(f.db, service, { ...input, prompt: "changed" }), /不同|generationKey|idempotencyKey/);
  } finally { await f.destroy(); }
});

test("derived asset and storyboard paths retain ordered references and isolate partial failure", options, async () => {
  const f = await fixture();
  try {
    const parentId = await asset(f, { name: "parent" });
    const [parentImageId] = await insertRowsReturningIds(f.db, "o_image", { assetsId: parentId, filePath: "/parent.jpg", state: "已完成", type: "role" });
    await f.db("o_assets").where({ id: parentId }).update({ imageId: parentImageId });
    const childId = await asset(f, { name: "child", assetsId: parentId });
    const log = { submits: [] as unknown[], queries: [] as string[] };
    const service = jobs(f.db, provider(log));
    const runtime: ProductionImageRuntime = {
      imageJobs: service, getArtPrompt: () => "system", generatePrompt: async ({ description }) => `derived:${description}`,
      getImageBase64: async (path) => `data:image/png;base64,${Buffer.from(path).toString("base64")}`,
      getSmallImageUrl: async (path) => `small:${path}`, uuid: () => "batch",
    };
    const derived = await prepareDerivedAssetImages(f.db, { projectId: f.projectId, scriptId: f.scriptId, assetIds: [childId], runtime, generationKeyPrefix: "derived-stable-key" });
    assert.equal((await derived.run())[0].state, "已完成");

    const [storyboardId] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, prompt: "shot", state: "未生成", shouldGenerateImage: 1, index: 1 });
    await f.db("o_assets2Storyboard").insert([{ storyboardId, assetId: childId }, { storyboardId, assetId: parentId }]);
    const storyboard = await prepareStoryboardImages(f.db, { projectId: f.projectId, scriptId: f.scriptId, storyboardIds: [storyboardId], runtime, generationKeyPrefix: "storyboard-stable-key" });
    assert.equal((await storyboard.run())[0].state, "已完成");
    const storyboardConfig = log.submits.at(-1) as { referenceList: Array<{ base64: string }> };
    assert.equal(storyboardConfig.referenceList.length, 2);
    const orderedLinks = await f.db("o_assets2Storyboard").where({ storyboardId }).orderBy("id");
    const expectedPaths: string[] = [];
    for (const link of orderedLinks) {
      const linkedAsset = await f.db("o_assets").where({ id: link.assetId }).first();
      expectedPaths.push((await f.db("o_image").where({ id: linkedAsset.imageId }).first()).filePath);
    }
    assert.deepEqual(storyboardConfig.referenceList.map((item) => Buffer.from(item.base64.split(",")[1], "base64").toString()), expectedPaths);
    assert.equal(log.submits.length, 2);
  } finally { await f.destroy(); }
});

test("late human storyboard edit saves an authorized candidate without overwriting the chosen frame", options, async () => {
  const f = await fixture();
  try {
    const [storyboardId] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, prompt: "before", filePath: "/old.jpg", state: "未生成", shouldGenerateImage: 1, index: 1 });
    const log = { submits: [] as unknown[], queries: [] as string[] };
    const service = jobs(f.db, provider(log));
    const runtime: ProductionImageRuntime = { imageJobs: service, getArtPrompt: () => "", generatePrompt: async () => "", getImageBase64: async () => "", getSmallImageUrl: async (path) => path, uuid: () => "late" };
    const prepared = await prepareStoryboardImages(f.db, { projectId: f.projectId, scriptId: f.scriptId, storyboardIds: [storyboardId], runtime, generationKeyPrefix: "late-human-key" });
    const state = await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: storyboardId }).first();
    await new ProductionStateService(f.db).updateStoryboardContent({ projectId: f.projectId, storyboardId, expectedVersion: Number(state.version), actor: { id: "human:1", kind: "human" }, patch: { prompt: "human choice" } });
    const result = await prepared.run();
    assert.equal(result[0].state, "已完成");
    const row = await f.db("o_storyboard").where({ id: storyboardId }).first();
    assert.equal(row.prompt, "human choice");
    assert.equal(row.filePath, "/old.jpg");
    assert.notEqual(row.state, "生成中");
    const binding = await f.db("ext_image_job_bindings").first();
    assert.equal(Boolean(binding.selected), false);
    assert.equal(await resolveImageArtifactProject(f.db, binding.artifactPath), f.projectId);
  } finally { await f.destroy(); }
});

test("flow image uses durable receipt and refuses a saved candidate owned by another project", options, async () => {
  const f = await fixture();
  try {
    const log = { submits: [] as unknown[], queries: [] as string[] };
    const service = jobs(f.db, provider(log));
    const generated = await generateFlowImage(f.db, service, { projectId: f.projectId, scriptId: f.scriptId, model: "zhenzhen:seedream-v5", quality: "1K", ratio: "16:9", prompt: "edit", references: [], generationKey: "flow-stable-key" }, { local: async () => "", remote: async () => "" });
    assert.equal(generated.status, "succeeded");
    assert.equal(await resolveImageArtifactProject(f.db, generated.artifactPath!), f.projectId);
    await assert.rejects(generateFlowImage(f.db, service, { projectId: f.projectId, model: "zhenzhen:seedream-v5", quality: "1K", ratio: "16:9", prompt: "wrong media", references: [`/oss${generated.artifactPath}`], generationKey: "wrong-media-flow-key" }, { local: async () => "data:video/mp4;base64,AAAA", remote: async () => "" }), /非图片媒体|无效数据/);
    let localReads = 0;
    await assert.rejects(generateFlowImage(f.db, service, { projectId: f.otherProjectId, model: "zhenzhen:seedream-v5", quality: "1K", ratio: "16:9", prompt: "steal", references: [`/oss${generated.artifactPath}`], generationKey: "foreign-flow-key" }, { local: async () => { localReads += 1; return ""; }, remote: async () => "" }), /不属于当前项目/);
    assert.equal(localReads, 0);
    const [otherAssetId] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.otherProjectId, name: "collision", type: "role" });
    const [otherImageId] = await insertRowsReturningIds(f.db, "o_image", { assetsId: otherAssetId, filePath: generated.artifactPath, state: "已完成", type: "role" });
    await f.db("o_assets").where({ id: otherAssetId }).update({ imageId: otherImageId });
    assert.equal(await resolveImageArtifactProject(f.db, `/oss${generated.artifactPath}`), undefined);
    const [unboundFlowId] = await insertRowsReturningIds(f.db, "o_imageFlow", { flowData: "{}" });
    await assert.rejects(generateFlowImage(f.db, service, { projectId: f.projectId, flowId: unboundFlowId, model: "zhenzhen:seedream-v5", quality: "1K", ratio: "16:9", prompt: "unbound", references: [], generationKey: "unbound-flow-key" }, { local: async () => "", remote: async () => "" }), /未唯一绑定当前项目/);
    await f.db("o_assets").where({ id: otherAssetId }).update({ flowId: unboundFlowId });
    await assert.rejects(generateFlowImage(f.db, service, { projectId: f.projectId, flowId: unboundFlowId, model: "zhenzhen:seedream-v5", quality: "1K", ratio: "16:9", prompt: "foreign flow", references: [], generationKey: "foreign-bound-flow-key" }, { local: async () => "", remote: async () => "" }), /未唯一绑定当前项目/);
    await assert.rejects(generateFlowImage(f.db, service, { projectId: 999999, model: "zhenzhen:seedream-v5", quality: "1K", ratio: "16:9", prompt: "missing project", references: [], generationKey: "missing-project-flow-key" }, { local: async () => "", remote: async () => "" }), /项目不存在/);
  } finally { await f.destroy(); }
});

test("restart resumes by query only and a late asset result cannot replace a human-selected candidate", options, async () => {
  const f = await fixture();
  try {
    const targetId = await asset(f);
    let upstream: "pending" | "succeeded" = "pending";
    let submits = 0;
    let queries = 0;
    const p: PersistentAsyncImageTaskProvider = {
      fingerprint: "seedream-relay-v1",
      submit: async () => { submits += 1; return { taskId: "restart-task" }; },
      query: async () => { queries += 1; return upstream === "pending" ? { status: "pending" } : { status: "succeeded", outputUrl: "https://relay.invalid/restart.jpg" }; },
    };
    const first = jobs(f.db, p);
    const input = { projectId: f.projectId, assetId: targetId, type: "role" as const, name: "hero", prompt: "wait", model: "zhenzhen:seedream-v5", resolution: "1K", generationKey: "restart-root-key", expectedVersion: 0 };
    const prepared = await prepareRootAssetImageForTest(f.db, first, input);
    const pending = await first.submitAndWait({ projectId: f.projectId, jobId: prepared.jobId, maxWaitMs: 0 });
    assert.equal(pending.status, "pending");
    const [humanImageId] = await insertRowsReturningIds(f.db, "o_image", { assetsId: targetId, filePath: "/human.jpg", state: "已完成", type: "role" });
    await f.db("o_assets").where({ id: targetId }).update({ imageId: humanImageId });

    upstream = "succeeded";
    const restarted = jobs(f.db, p);
    const reused = await prepareRootAssetImageForTest(f.db, restarted, input);
    assert.equal(reused.jobId, prepared.jobId);
    assert.equal(submits, 1);
    const beforeQuery = queries;
    assert.equal((await restarted.get({ projectId: f.projectId, jobId: prepared.jobId })).status, "pending");
    assert.equal(queries, beforeQuery);
    const completed = await restarted.submitAndWait({ projectId: f.projectId, jobId: prepared.jobId });
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.selected, false);
    assert.equal(submits, 1);
    assert.equal(Number((await f.db("o_assets").where({ id: targetId }).first()).imageId), humanImageId);
  } finally { await f.destroy(); }
});

test("one failed upstream item does not discard another saved batch candidate", options, async () => {
  const f = await fixture();
  try {
    const firstId = await asset(f, { name: "first" });
    const secondId = await asset(f, { name: "second" });
    const p: PersistentAsyncImageTaskProvider = {
      fingerprint: "seedream-relay-v1",
      submit: async (config) => ({ taskId: String((config as { prompt: string }).prompt).includes("first prompt") ? "batch-ok" : "batch-failed" }),
      query: async (taskId) => taskId === "batch-ok" ? { status: "succeeded", outputUrl: "https://relay.invalid/one.jpg" } : { status: "failed", error: "provider rejected second" },
    };
    const service = jobs(f.db, p);
    const common = { projectId: f.projectId, type: "role" as const, prompt: "batch", model: "zhenzhen:seedream-v5", resolution: "1K", expectedVersion: 0 };
    const [one, two] = await Promise.all([
      generateRootAssetImage(f.db, service, { ...common, assetId: firstId, name: "first", prompt:"first prompt", generationKey: "partial-first-key" }),
      generateRootAssetImage(f.db, service, { ...common, assetId: secondId, name: "second", prompt:"second prompt", generationKey: "partial-second-key" }),
    ]);
    assert.equal(one.status, "succeeded");
    assert.equal(two.status, "failed");
    assert.equal((await f.db("o_image").where({ assetsId: firstId }).orderBy("id", "desc").first()).state, "已完成");
    assert.equal((await f.db("o_image").where({ assetsId: secondId }).orderBy("id", "desc").first()).state, "生成失败");
  } finally { await f.destroy(); }
});

test("paused or revoked builtin runs keep late asset output as an unselected authorized candidate", options, async () => {
  const f = await fixture();
  try {
    await f.db.schema.createTable("ext_builtin_runs", (table) => { table.uuid("id").primary(); table.bigInteger("projectId"); table.text("status"); table.integer("inputRevision"); table.integer("requestedBy"); table.integer("executionUserId"); });
    await f.db.schema.createTable("team_users", (table) => { table.integer("user_id").primary(); table.boolean("enabled"); table.text("role"); });
    await f.db("team_users").insert({ user_id: 7, enabled: true, role: "editor" });
    const p = provider({ submits: [], queries: [] });
    const service = jobs(f.db, p);
    for (const mode of ["paused", "revoked"] as const) {
      const targetId = await asset(f, { name: mode });
      const [oldImageId] = await insertRowsReturningIds(f.db, "o_image", { assetsId: targetId, filePath: `/${mode}-old.jpg`, state: "已完成", type: "role" });
      await f.db("o_assets").where({ id: targetId }).update({ imageId: oldImageId });
      const runId = mode === "paused" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002";
      await f.db("ext_builtin_runs").insert({ id: runId, projectId: f.projectId, status: "running", inputRevision: 3, requestedBy: 7 });
      const prepared = await service.prepare({
        generationKey: `builtin-${mode}-late`, projectId: f.projectId, modelKey: "zhenzhen:seedream-v5",
        config: { prompt: mode, referenceList: [], size: "1K", aspectRatio: "16:9" },
        target: { kind: "asset", id: targetId, scriptId: f.scriptId, expectedVersion: oldImageId },
        builtinRun: { id: runId, inputRevision: 3 },
      });
      assert.equal(Number((await f.db("o_assets").where({ id: targetId }).first()).imageId), oldImageId);
      if (mode === "paused") await f.db("ext_builtin_runs").where({ id: runId }).update({ status: "paused" });
      else await f.db("team_users").where({ user_id: 7 }).update({ enabled: false });
      const receipt = await service.submitAndWait({ projectId: f.projectId, jobId: prepared.jobId });
      assert.equal(receipt.status, "succeeded");
      assert.equal(receipt.selected, false);
      assert.equal(Number((await f.db("o_assets").where({ id: targetId }).first()).imageId), oldImageId);
      assert.equal(await resolveImageArtifactProject(f.db, receipt.artifactPath!), f.projectId);
      if (mode === "revoked") await f.db("team_users").where({ user_id: 7 }).update({ enabled: true });
    }
  } finally { await f.destroy(); }
});

test("recovery reconstructs a reserved job whose binding transaction never committed", options, async () => {
  const f = await fixture();
  try {
    const targetId = await asset(f);
    const log = { submits: [] as unknown[], queries: [] as string[] };
    const p = provider(log);
    const first = jobs(f.db, p);
    const prepared = await prepareRootAssetImageForTest(f.db, first, { projectId: f.projectId, assetId: targetId, type: "role", name: "hero", prompt: "orphan", model: "zhenzhen:seedream-v5", resolution: "1K", generationKey: "orphan-binding-key", expectedVersion: 0 });
    const binding = await f.db("ext_image_job_bindings").where({ jobId: prepared.jobId }).first();
    await f.db("o_assets").where({ id: targetId }).update({ imageId: null });
    await f.db("o_image").where({ id: binding.candidateImageId }).del();
    await f.db("ext_image_job_bindings").where({ jobId: prepared.jobId }).del();
    const restarted = jobs(f.db, p);
    await restarted.recover();
    const recoveredBinding = await f.db("ext_image_job_bindings").where({ jobId: prepared.jobId }).first();
    assert(Number(recoveredBinding.candidateImageId) > 0);
    const result = await restarted.submitAndWait({ projectId: f.projectId, jobId: prepared.jobId });
    assert.equal(result.status, "succeeded");
    assert.equal(log.submits.length, 1);
  } finally { await f.destroy(); }
});

test("a target changed between reserve and binding becomes a durable prepare failure without a provider POST", options, async () => {
  const f = await fixture();
  try {
    const targetId = await asset(f);
    let release!: () => void;
    let providerEntered!: () => void;
    const entered = new Promise<void>((resolve) => { providerEntered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let submits = 0;
    const p = provider({ submits: [], queries: [] });
    const service = createImageGenerationService({
      db: f.db, providerFor: async () => { providerEntered(); await gate; return { ...p, submit: async (config) => { submits += 1; return p.submit(config); } }; },
      download: async () => undefined, uuid: () => "prepare-race", pollMs: 10,
    });
    const preparing = prepareRootAssetImageForTest(f.db, service, { projectId: f.projectId, assetId: targetId, type: "role", name: "hero", prompt: "race", model: "zhenzhen:seedream-v5", resolution: "1K", generationKey: "prepare-failure-key", expectedVersion: 0 });
    await entered;
    const [humanImageId] = await insertRowsReturningIds(f.db, "o_image", { assetsId: targetId, filePath: "/human-race.jpg", state: "已完成", type: "role" });
    await f.db("o_assets").where({ id: targetId }).update({ imageId: humanImageId });
    release();
    await assert.rejects(preparing, /已被其他操作修改/);
    const job = await f.db("ext_image_jobs").where({ idempotencyKey: "prepare-failure-key" }).first();
    const binding = await f.db("ext_image_job_bindings").where({ jobId: job.id }).first();
    assert.equal(job.status, "FAILED");
    assert.equal(binding.state, "FAILED");
    assert.equal(binding.candidateImageId, null);
    assert.equal(submits, 0);
  } finally { await f.destroy(); }
});

async function prepareRootAssetImageForTest(db: Knex, service: ImageGenerationService, input: Parameters<typeof generateRootAssetImage>[2]) {
  const project = await db("o_project").where({ id: input.projectId }).first();
  const cfg = `style:${project.artStyle};name:${input.name};prompt:${input.prompt}`;
  return service.prepare({ generationKey: input.generationKey, projectId: input.projectId, modelKey: input.model, config: { prompt: cfg, referenceList: [], size: input.resolution, aspectRatio: "16:9" }, target: { kind: "asset", id: input.assetId } });
}

test('running builtin jobs keep chosen root images while still applying new derived images', options, async()=>{
 const f=await fixture();try{
  await f.db.schema.createTable('ext_builtin_runs',t=>{t.uuid('id').primary();t.bigInteger('projectId');t.text('status');t.integer('inputRevision');t.integer('requestedBy');t.integer('executionUserId')});
  await f.db.schema.createTable('team_users',t=>{t.integer('user_id').primary();t.boolean('enabled');t.text('role')});await f.db('team_users').insert({user_id:7,enabled:true,role:'editor'});
  const runId='00000000-0000-4000-8000-000000000011';await f.db('ext_builtin_runs').insert({id:runId,projectId:f.projectId,status:'running',inputRevision:0,requestedBy:7});
  const rootId=await asset(f,{name:'selected-root'});const [oldImageId]=await insertRowsReturningIds(f.db,'o_image',{assetsId:rootId,filePath:'/old.jpg',state:'已完成',type:'role'});await f.db('o_assets').where({id:rootId}).update({imageId:oldImageId});
  const childId=await asset(f,{name:'child',assetsId:rootId});const service=jobs(f.db,provider({submits:[],queries:[]}));
  for(const [id,previous,expectedSelected] of [[rootId,oldImageId,false],[childId,0,true]] as const){const prepared=await service.prepare({generationKey:`protect-root-${id}`,projectId:f.projectId,modelKey:'zhenzhen:seedream-v5',config:{prompt:'same identity',referenceList:[],size:'1K',aspectRatio:'16:9'},target:{kind:'asset',id,scriptId:f.scriptId,expectedVersion:previous},builtinRun:{id:runId,inputRevision:0}});const result=await service.submitAndWait({projectId:f.projectId,jobId:prepared.jobId});assert.equal(result.status,'succeeded');assert.equal(result.selected,expectedSelected);const row=await f.db('o_assets').where({id}).first();if(!expectedSelected)assert.equal(Number(row.imageId),oldImageId);else assert.ok(Number(row.imageId)>0);}
 }finally{await f.destroy();}
});
