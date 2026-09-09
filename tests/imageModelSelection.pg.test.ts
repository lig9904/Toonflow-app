import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { resolveRegisteredImageModel } from "../src/lib/imageModelSelection";
import { createImageGenerationService, ensureProductionImageJobSchema } from "../src/services/imageJobs/runtime";
import { loadOwnedVideoReferences } from "../src/services/videoJobs/request";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const models = [
  { modelName: "seedream-v5-pro-t2i", type: "image", mode: ["text"] },
  { modelName: "seedream-v5-pro-i2i", type: "image", mode: ["singleImage", "multiReference"] },
  { modelName: "dola-seedream-5.0-pro-t2i", type: "image", mode: ["text"] },
  { modelName: "dola-seedream-5.0-pro-i2i", type: "image", mode: ["singleImage", "multiReference"] },
];

test("PostgreSQL jobs persist effective T2I/I2I selection and replay with one upstream submit", options, async () => {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureProductionImageJobSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "image model pairing" });
  const submitted: Array<{ modelKey: string; config: unknown }> = [];
  let resolveCalls = 0;
  let rejectFreshResolution = false;
  let providerDisabled = false;
  const createService = () => createImageGenerationService({
    db: f.db,
    resolveModel: async (requestedKey, referenceCount) => {
      resolveCalls += 1;
      if (rejectFreshResolution) throw new Error("resolver should not run for an existing generationKey");
      return resolveRegisteredImageModel({ requestedKey, providerEnabled: true, models, referenceCount }).key;
    },
    providerFor: async (modelKey) => {
      if (providerDisabled) throw new Error("provider disabled");
      return ({
      fingerprint: `fingerprint:${modelKey}`,
      submit: async (config) => { submitted.push({ modelKey, config }); return { taskId: `task-${submitted.length}` }; },
      query: async (taskId) => ({ status: "succeeded" as const, outputUrl: `https://fixture.invalid/${taskId}.jpg` }),
      });
    },
    download: async () => undefined,
    uuid: () => "paired-model-output",
    pollMs: 10,
  });
  let service = createService();
  try {
    const textInput = {
      generationKey: "pairing-text-generation", projectId, modelKey: "vendor-a:seedream-v5-pro-i2i",
      config: { prompt: "new character", referenceList: [], size: "1K", aspectRatio: "16:9" },
      target: { kind: "flow" as const, id: "text-flow" },
    };
    const text = await service.prepareAndSubmit(textInput);
    assert.equal(text.status, "succeeded");
    assert.equal((await f.db("ext_image_jobs").where({ id: text.jobId }).first()).modelKey, "vendor-a:seedream-v5-pro-t2i");

    const imageInput = {
      generationKey: "pairing-image-generation", projectId, modelKey: "vendor-a:seedream-v5-pro-t2i",
      config: { prompt: "change coat", referenceList: [{ type: "image" as const, base64: "data:image/png;base64,YQ==" }], size: "1K", aspectRatio: "16:9" },
      target: { kind: "flow" as const, id: "image-flow" },
    };
    const image = await service.prepareAndSubmit(imageInput);
    assert.equal(image.status, "succeeded");
    const imageJob = await f.db("ext_image_jobs").where({ id: image.jobId }).first();
    assert.equal(imageJob.modelKey, "vendor-a:seedream-v5-pro-i2i");
    assert.equal(JSON.parse(imageJob.payload).context.requestedModelKey, "vendor-a:seedream-v5-pro-t2i");
    assert.deepEqual(submitted.map((entry) => entry.modelKey), ["vendor-a:seedream-v5-pro-t2i", "vendor-a:seedream-v5-pro-i2i"]);

    service.stop();
    rejectFreshResolution = true;
    providerDisabled = true;
    service = createService();
    assert.equal((await service.get({ projectId, generationKey: imageInput.generationKey })).jobId, image.jobId, "completed receipts remain readable while the current provider is disabled");
    providerDisabled = false;
    const replay = await service.prepareAndSubmit(imageInput);
    assert.equal(replay.jobId, image.jobId);
    assert.equal(resolveCalls, 2, "existing jobs retain their effective model without resolving again");
    assert.equal(submitted.length, 2, "replay must not submit upstream again");
    await assert.rejects(service.prepare({ ...imageInput, modelKey: "vendor-a:dola-seedream-5.0-pro-t2i" }), /请求图片模型/);
    await assert.rejects(service.prepare({ ...imageInput, config: { ...imageInput.config, prompt: "changed" } }), /不同的图片任务参数|idempotencyKey/);
  } finally {
    service.stop();
    await f.destroy();
  }
});

test("PostgreSQL prepare rejects a missing same-family counterpart before reserve or submit", options, async () => {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureProductionImageJobSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "no cross-family fallback" });
  let providerCalls = 0;
  const service = createImageGenerationService({
    db: f.db,
    resolveModel: async (requestedKey, referenceCount) => resolveRegisteredImageModel({ requestedKey, providerEnabled: true,
      models: models.filter((model) => model.modelName !== "seedream-v5-pro-i2i"), referenceCount }).key,
    providerFor: async () => { providerCalls += 1; throw new Error("provider must not be reached"); },
    download: async () => undefined,
  });
  try {
    await assert.rejects(service.prepare({
      generationKey: "cross-family-rejected", projectId, modelKey: "vendor-a:seedream-v5-pro-t2i",
      config: { prompt: "edit", referenceList: [{ type: "image", base64: "data:image/png;base64,YQ==" }], size: "1K", aspectRatio: "16:9" },
      target: { kind: "flow", id: "reject-flow" },
    }), /seedream-v5-pro-i2i/);
    assert.equal(providerCalls, 0);
    assert.equal(Number((await f.db("ext_image_jobs").count<{ count: string }>("id as count").first())?.count ?? 0), 0);
  } finally {
    service.stop();
    await f.destroy();
  }
});

test("PostgreSQL reference loading preserves storyboard-then-asset order and enforces script ownership", options, async () => {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "ordered references" });
  const [scriptId] = await insertRowsReturningIds(f.db, "o_script", { projectId, name: "episode one" });
  const [otherScriptId] = await insertRowsReturningIds(f.db, "o_script", { projectId, name: "episode two" });
  const [storyboardId] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId, scriptId, filePath: "/storyboard.png" });
  const [assetId] = await insertRowsReturningIds(f.db, "o_assets", { projectId, name: "hero", type: "role" });
  const [imageId] = await insertRowsReturningIds(f.db, "o_image", { assetsId: assetId, filePath: "/asset.png", type: "role", state: "已完成" });
  await f.db("o_assets").where({ id: assetId }).update({ imageId });
  await f.db("o_scriptAssets").insert({ scriptId, assetId });
  try {
    const references = await loadOwnedVideoReferences(f.db, projectId, scriptId, [
      { sources: "storyboard", id: storyboardId, fileType: "image" },
      { sources: "assets", id: assetId, fileType: "image" },
    ], async (path) => `data:image/png;base64,${Buffer.from(path).toString("base64")}`);
    assert.deepEqual(references.map((reference) => Buffer.from(reference.base64.split(",")[1], "base64").toString()), ["/storyboard.png", "/asset.png"]);
    await assert.rejects(loadOwnedVideoReferences(f.db, projectId, otherScriptId, [{ sources: "assets", id: assetId, fileType: "image" }], async () => "unused"), /当前项目|媒体文件/);
  } finally {
    await f.destroy();
  }
});
