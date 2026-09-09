import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { generateDerivedAssetImages, generateStoryboardImages, prepareDerivedAssetImages, prepareStoryboardImages, ProductionImageError, type ProductionImageRuntime } from "../src/services/productionImages";
import { ProductionStateService } from "../src/services/productionState";
import { closeProductionFixture, createProductionFixture, type ProductionFixture } from "./helpers/productionFixture";

function runtime(options: { failPromptFor?: string; failSaveFor?: string } = {}) {
  let active = 0;
  let maxActive = 0;
  let sequence = 0;
  const generated: Array<{ prompt: string; refs: number }> = [];
  const value: ProductionImageRuntime & { maxActive: () => number; generated: typeof generated } = {
    getArtPrompt: () => "mock art prompt",
    generatePrompt: async ({ description }) => {
      if (description === options.failPromptFor) throw new Error("提示词生成异常");
      return `generated:${description}`;
    },
    generateImage: async ({ prompt, referenceList }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      generated.push({ prompt, refs: referenceList.length });
      await new Promise((resolve) => setTimeout(resolve, 2));
      return {
        save: async () => {
          active -= 1;
          if (prompt.includes(options.failSaveFor || "\u0000")) throw new Error("图片保存异常");
        },
      };
    },
    getImageBase64: async (path) => `base64:${path}`,
    getSmallImageUrl: async (path) => `small:${path}`,
    uuid: () => `mock-${++sequence}`,
    maxActive: () => maxActive,
    generated,
  };
  return value;
}

describe("production image generation service", () => {
  let fixture: ProductionFixture;
  beforeEach(async () => { fixture = await createProductionFixture(); });
  afterEach(async () => { await closeProductionFixture(fixture); });

  it("validates all asset IDs and parent image material before any model call", async () => {
    const mocked = runtime();
    await assert.rejects(generateDerivedAssetImages(fixture.db, { projectId: 100, scriptId: 10, assetIds: [1, 9], runtime: mocked }), (error: unknown) => error instanceof ProductionImageError && error.status === 404);
    assert.equal(mocked.generated.length, 0);
    assert.equal(await fixture.db("o_image").where({ state: "生成中" }).count<{ count: number }>("* as count").first().then((row) => Number(row?.count)), 0);
  });

  it("persists prompt failure and successful images while respecting bounded concurrency", async () => {
    const mocked = runtime({ failPromptFor: "child desc" });
    const result = await generateDerivedAssetImages(fixture.db, { projectId: 100, scriptId: 10, assetIds: [1, 2], concurrentCount: 1, runtime: mocked });
    assert.equal(mocked.maxActive(), 1);
    assert.deepEqual(result.map((item) => item.state).sort(), ["已完成", "生成失败"]);
    const failed = await fixture.db("o_image").where({ assetsId: 2 }).orderBy("id", "desc").first();
    assert.equal(failed.state, "生成失败");
    assert.match(failed.errorReason, /提示词生成异常/);
    assert.equal((await fixture.db("o_assets").where({ id: 1 }).first()).prompt, "generated:hero desc");
    assert.equal((await fixture.db("o_image").where({ assetsId: 1 }).orderBy("id", "desc").first()).state, "已完成");
  });

  it("claims and previews before model execution; run starts the injected model", async () => {
    const mocked = runtime();
    const prepared = await prepareDerivedAssetImages(fixture.db, { projectId: 100, scriptId: 10, assetIds: [2], runtime: mocked });
    assert.equal(prepared.preview[0].state, "生成中");
    assert.equal(mocked.generated.length, 0);
    const result = await prepared.run();
    assert.equal(result[0].state, "已完成");
    assert.equal(mocked.generated.length, 1);
  });

  it("rejects a second asset claim while its current image is generating", async () => {
    const [imageId] = await fixture.db("o_image").insert({ assetsId: 2, type: "role", state: "生成中", model: "1:mock-image", resolution: "1K" });
    await fixture.db("o_assets").where({ id: 2 }).update({ imageId });
    const mocked = runtime();
    await assert.rejects(generateDerivedAssetImages(fixture.db, { projectId: 100, scriptId: 10, assetIds: [2], runtime: mocked }), (error: unknown) => error instanceof ProductionImageError && error.status === 409);
    assert.equal(mocked.generated.length, 0);
  });

  it("rejects locked storyboard material before any paid generation and persists save failures", async () => {
    const mocked = runtime({ failSaveFor: "real prompt" });
    await fixture.db("o_storyboard").insert({ id: 401, projectId: 100, scriptId: 10, index: 0, duration: "2", prompt: "real prompt", filePath: "/old.jpg", state: "未生成", shouldGenerateImage: 1, track: "A", trackId: null });
    await fixture.db("o_assets2Storyboard").insert({ storyboardId: 401, assetId: 1 });
    await fixture.db("ext_entity_state").where({ entityType: "storyboard", entityId: 401 }).update({ locked: true, lockedBy: "human:7" });
    await assert.rejects(generateStoryboardImages(fixture.db, { projectId: 100, scriptId: 10, storyboardIds: [401], runtime: mocked }), (error: unknown) => error instanceof ProductionImageError && error.status === 423);
    assert.equal(mocked.generated.length, 0);

    await fixture.db("ext_entity_state").where({ entityType: "storyboard", entityId: 401 }).update({ locked: false, lockedBy: null });
    const result = await generateStoryboardImages(fixture.db, { projectId: 100, scriptId: 10, storyboardIds: [401], runtime: mocked });
    assert.equal(result[0].state, "生成失败");
    const row = await fixture.db("o_storyboard").where({ id: 401 }).first();
    assert.equal(row.state, "生成失败");
    assert.equal(row.filePath, "/old.jpg");
    assert.match(row.reason, /图片保存异常/);
  });

  it("rejects a storyboard changed after material read before any model call", async () => {
    await fixture.db("o_storyboard").insert({ id: 402, projectId: 100, scriptId: 10, index: 0, duration: "2", prompt: "before", state: "未生成", shouldGenerateImage: 1, track: "A", trackId: null });
    await fixture.db("o_assets2Storyboard").insert({ storyboardId: 402, assetId: 1 });
    let releaseMaterial!: () => void;
    let materialRead!: () => void;
    const materialReady = new Promise<void>((resolve) => { materialRead = resolve; });
    const materialGate = new Promise<string>((resolve) => { releaseMaterial = () => resolve("base64:held"); });
    const mocked = runtime();
    mocked.getImageBase64 = async () => { materialRead(); return materialGate; };
    const preparing = prepareStoryboardImages(fixture.db, { projectId: 100, scriptId: 10, storyboardIds: [402], runtime: mocked });
    await materialReady;
    await fixture.db("o_storyboard").where({ id: 402 }).update({ prompt: "changed while reading" });
    releaseMaterial();
    await assert.rejects(preparing, (error: unknown) => error instanceof ProductionImageError && error.status === 409);
    assert.equal(mocked.generated.length, 0);
  });

  it("releases a stale generating state after a human edit without clearing content or old image", async () => {
    await fixture.db("o_storyboard").insert({ id: 403, projectId: 100, scriptId: 10, index: 0, duration: "2", prompt: "before", filePath: "/old-storyboard.jpg", state: "未生成", shouldGenerateImage: 1, track: "A", trackId: null });
    await fixture.db("o_assets2Storyboard").insert({ storyboardId: 403, assetId: 1 });
    let releaseModel!: () => void;
    let modelStarted!: () => void;
    const modelReady = new Promise<void>((resolve) => { modelStarted = resolve; });
    const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
    const mocked = runtime();
    mocked.generateImage = async () => {
      modelStarted();
      await modelGate;
      return { save: async () => undefined };
    };
    const prepared = await prepareStoryboardImages(fixture.db, { projectId: 100, scriptId: 10, storyboardIds: [403], runtime: mocked });
    const run = prepared.run();
    await modelReady;
    const claimState = await fixture.db("ext_entity_state").where({ entityType: "storyboard", entityId: 403 }).first();
    await new ProductionStateService(fixture.db).updateStoryboardContent({
      projectId: 100, storyboardId: 403, expectedVersion: Number(claimState.version), actor: { id: "human:7", kind: "human" }, patch: { prompt: "human edit" },
    });
    releaseModel();
    const result = await run;
    assert.equal(result[0].state, "生成失败");
    const row = await fixture.db("o_storyboard").where({ id: 403 }).first();
    assert.equal(row.prompt, "human edit");
    assert.equal(row.filePath, "/old-storyboard.jpg");
    assert.notEqual(row.state, "生成中");
  });

  it("rejects incomplete storyboard batches instead of silently dropping IDs", async () => {
    const mocked = runtime();
    await assert.rejects(generateStoryboardImages(fixture.db, { projectId: 100, scriptId: 10, storyboardIds: [999], runtime: mocked }), (error: unknown) => error instanceof ProductionImageError && error.status === 404);
    assert.equal(mocked.generated.length, 0);
  });
});
