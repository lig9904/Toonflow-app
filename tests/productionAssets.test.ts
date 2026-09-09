import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createOrUpdateDerivedAsset, deleteDerivedAsset, ProductionAssetError, updateDerivedAssetImage } from "../src/services/productionAssets";
import { closeProductionFixture, createProductionFixture, type ProductionFixture } from "./helpers/productionFixture";

describe("production derived asset service", () => {
  let fixture: ProductionFixture;
  beforeEach(async () => { fixture = await createProductionFixture(); });
  afterEach(async () => { await closeProductionFixture(fixture); });

  it("creates and updates a child with project, episode, and parent binding", async () => {
    const created = await createOrUpdateDerivedAsset(fixture.db, { projectId: 100, scriptId: 10, parentAssetId: 1, name: "new child", description: "new description" });
    const row = await fixture.db("o_assets").where({ id: created.id }).first();
    assert.equal(row.projectId, 100);
    assert.equal(row.scriptId, 10);
    assert.equal(row.assetsId, 1);
    assert.equal((await fixture.db("o_scriptAssets").where({ scriptId: 10, assetId: created.id })).length, 1);

    const updated = await createOrUpdateDerivedAsset(fixture.db, { projectId: 100, scriptId: 10, parentAssetId: 1, id: created.id, name: "updated child", description: "updated description" });
    assert.equal(updated.created, false);
    assert.equal((await fixture.db("o_assets").where({ id: created.id }).first()).name, "updated child");
    const image = await updateDerivedAssetImage(fixture.db, { projectId: 100, scriptId: 10, id: created.id, url: "/assets/new.jpg", flowId: 901 });
    assert.equal((await fixture.db("o_assets").where({ id: created.id }).first()).imageId, image.imageId);
    assert.equal((await fixture.db("o_image").where({ id: image.imageId }).first()).filePath, "/assets/new.jpg");
  });

  it("rejects a parent or episode outside the authenticated project", async () => {
    await assert.rejects(createOrUpdateDerivedAsset(fixture.db, { projectId: 100, scriptId: 10, parentAssetId: 9, name: "bad", description: "bad" }), (error: unknown) => error instanceof ProductionAssetError && error.status === 404);
    await assert.rejects(createOrUpdateDerivedAsset(fixture.db, { projectId: 200, scriptId: 10, parentAssetId: 1, name: "bad", description: "bad" }), (error: unknown) => error instanceof ProductionAssetError && error.status === 404);
    assert.equal(await fixture.db("o_assets").where({ name: "bad" }).first(), undefined);
  });

  it("rejects locked storyboard references before deleting image, links, or asset rows", async () => {
    await fixture.db("o_assets").where({ id: 2 }).update({ flowId: 900 });
    await fixture.db("o_imageFlow").insert({ id: 900, flowData: "{}" });
    await fixture.db("o_storyboard").insert({ id: 301, projectId: 100, scriptId: 10, index: 0, duration: "2", prompt: "locked", state: "已完成", track: "A", trackId: null });
    await fixture.db("o_assets2Storyboard").insert({ storyboardId: 301, assetId: 2 });
    await fixture.db("ext_entity_state").where({ entityType: "storyboard", entityId: 301 }).update({ projectId: 100, version: 1, reviewState: "approved", locked: true, lockedBy: "human:7" });
    await assert.rejects(deleteDerivedAsset(fixture.db, { projectId: 100, scriptId: 10, parentAssetId: 1, id: 2 }), (error: unknown) => error instanceof ProductionAssetError && error.status === 423);
    assert.ok(await fixture.db("o_assets").where({ id: 2 }).first());
    assert.ok(await fixture.db("o_image").where({ assetsId: 2 }).first());
    assert.ok(await fixture.db("o_assets2Storyboard").where({ storyboardId: 301, assetId: 2 }).first());
    assert.ok(await fixture.db("o_imageFlow").where({ id: 900 }).first());
  });

  it("deletes the child, source image, links, and orphaned image flow in one transaction", async () => {
    await fixture.db("o_assets").where({ id: 2 }).update({ flowId: 900 });
    await fixture.db("o_imageFlow").insert({ id: 900, flowData: "{}" });
    await fixture.db("o_assets2Storyboard").insert({ storyboardId: 301, assetId: 2 });
    await deleteDerivedAsset(fixture.db, { projectId: 100, scriptId: 10, parentAssetId: 1, id: 2 });
    assert.equal(await fixture.db("o_assets").where({ id: 2 }).first(), undefined);
    assert.equal(await fixture.db("o_image").where({ assetsId: 2 }).first(), undefined);
    assert.equal(await fixture.db("o_assets2Storyboard").where({ assetId: 2 }).first(), undefined);
    assert.equal(await fixture.db("o_imageFlow").where({ id: 900 }).first(), undefined);
  });
});
