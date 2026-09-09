import assert from "node:assert/strict";
import { ProductionStateService } from "../src/services/productionState";
import { afterEach, beforeEach, describe, it } from "node:test";
import { addProductionStoryboards, ProductionFlowError, readProductionFlow, saveProductionPlanning } from "../src/services/productionFlow";
import { closeProductionFixture, createProductionFixture, newStoryboard, productionUrl, type ProductionFixture } from "./helpers/productionFixture";

describe("production flow relational source of truth", () => {
  let f: ProductionFixture;

  beforeEach(async () => {
    f = await createProductionFixture();
  });

  afterEach(async () => {
    await closeProductionFixture(f);
  });

  it("returns existing storyboards when the planning cache is absent", async () => {
    await f.db("o_storyboard").insert({
      id: 101, projectId: 100, scriptId: 10, index: 0, duration: "4", prompt: "stored prompt",
      state: "未生成", videoDesc: "stored storyboard", shouldGenerateImage: 1, track: "A", trackId: null,
    });
    const flow = await readProductionFlow(f.db, 100, 10, productionUrl);
    assert.equal(flow.script, "database script");
    assert.deepEqual(flow.storyboard.map((row) => row.id), [101]);
    assert.equal(flow.storyboard[0].prompt, "stored prompt");
    assert.equal(flow.assets[0].id, 1);
    assert.equal(flow.assets[0].derive[0].id, 2);
  });

  it("does not let damaged or forged cache replace core script, storyboard, or asset rows", async () => {
    await f.db("o_storyboard").insert({
      id: 102, projectId: 100, scriptId: 10, index: 0, duration: "2", prompt: "real prompt",
      state: "已完成", videoDesc: "real storyboard", shouldGenerateImage: 0, track: "A", trackId: null,
    });
    await f.db("o_agentWorkData").insert({ projectId: 100, episodesId: 10, key: "productionAgent", data: "{broken" });
    const damaged = await readProductionFlow(f.db, 100, 10, productionUrl);
    assert.equal(damaged.script, "database script");
    assert.deepEqual(damaged.storyboard.map((row) => row.id), [102]);
    assert.deepEqual(damaged.assets.map((asset) => asset.id), [1]);
    assert.equal(damaged.scriptPlan, "");

    await f.db("o_agentWorkData").where({ projectId: 100, episodesId: 10, key: "productionAgent" }).update({
      data: JSON.stringify({ script: "forged script", storyboard: [{ id: 999 }], assets: [{ id: 999 }], scriptPlan: "trusted plan", storyboardTable: "trusted table" }),
    });
    const forged = await readProductionFlow(f.db, 100, 10, productionUrl);
    assert.equal(forged.script, "database script");
    assert.deepEqual(forged.storyboard.map((row) => row.id), [102]);
    assert.deepEqual(forged.assets.map((asset) => asset.id), [1]);
    assert.equal(forged.scriptPlan, "trusted plan");
    assert.equal(forged.storyboardTable, "trusted table");
  });

  it("rejects project and episode mismatches before reading or writing", async () => {
    await assert.rejects(readProductionFlow(f.db, 200, 10, productionUrl), (error: unknown) => error instanceof ProductionFlowError && error.status === 404);
    await assert.rejects(readProductionFlow(f.db, 100, 20, productionUrl), (error: unknown) => error instanceof ProductionFlowError && error.status === 404);
    await assert.rejects(addProductionStoryboards(f.db, 200, 10, [newStoryboard()]), (error: unknown) => error instanceof ProductionFlowError && error.status === 404);
  });

  it("adds storyboards, asset links, and one track atomically", async () => {
    const ids = await addProductionStoryboards(f.db, 100, 10, [
      newStoryboard({ duration: 3, associateAssetsIds: [1, 2] }),
      newStoryboard({ duration: 4, associateAssetsIds: [1] }),
    ]);
    assert.equal(ids.length, 2);
    assert.equal(await f.db("o_videoTrack").where({ scriptId: 10, projectId: 100 }).count<{ count: number }>("* as count").first().then((row) => Number(row?.count)), 1);
    const rows = await f.db("o_storyboard").whereIn("id", ids).orderBy("index");
    assert.deepEqual(rows.map((row) => row.index), [0, 1]);
    assert.equal(rows[0].trackId, rows[1].trackId);
    assert.equal(Number((await f.db("o_videoTrack").where({ id: rows[0].trackId }).first()).duration), 7);
    assert.deepEqual(await f.db("o_assets2Storyboard").whereIn("storyboardId", ids).orderBy(["storyboardId", "assetId"]), [
      { storyboardId: ids[0], assetId: 1 }, { storyboardId: ids[0], assetId: 2 }, { storyboardId: ids[1], assetId: 1 },
    ]);
  });

  it("rolls back all writes when any referenced asset belongs to another project", async () => {
    await assert.rejects(addProductionStoryboards(f.db, 100, 10, [newStoryboard({ associateAssetsIds: [1, 9] })]), /引用素材不属于当前项目/);
    assert.equal(await f.db("o_storyboard").count<{ count: number }>("* as count").first().then((row) => Number(row?.count)), 0);
    assert.equal(await f.db("o_assets2Storyboard").count<{ count: number }>("* as count").first().then((row) => Number(row?.count)), 0);
    assert.equal(await f.db("o_videoTrack").count<{ count: number }>("* as count").first().then((row) => Number(row?.count)), 0);
  });

  it("reuses a track without rewriting an existing locked storyboard", async () => {
    await f.db("o_videoTrack").insert({ id: 7, scriptId: 10, projectId: 100, duration: 5 });
    await f.db("o_storyboard").insert({
      id: 701, projectId: 100, scriptId: 10, index: 4, duration: "5", prompt: "locked original", filePath: "/locked.png",
      state: "已完成", videoDesc: "locked description", shouldGenerateImage: 0, reason: "keep", flowId: "original", track: "A", trackId: 7, createTime: 1,
    });
    await f.db("ext_entity_state").insert({ entityType: "storyboard", entityId: 701, projectId: 100, version: 3, reviewState: "approved", locked: true, lockedBy: "human:7" });
    const [newId] = await addProductionStoryboards(f.db, 100, 10, [newStoryboard({ track: "A", duration: 2 })]);
    const original = await f.db("o_storyboard").where({ id: 701 }).first();
    assert.equal(original.prompt, "locked original");
    assert.equal(original.filePath, "/locked.png");
    assert.equal(original.trackId, 7);
    const added = await f.db("o_storyboard").where({ id: newId }).first();
    assert.equal(added.trackId, 7);
    assert.equal(await f.db("o_videoTrack").where({ id: 7 }).first().then((row: any) => Number(row.duration)), 7);
    assert.equal((await f.db("ext_entity_state").where({ entityId: 701 }).first()).locked, 1);
  });

  it("rejects a stale planning version and preserves the newer planning document", async () => {
    const first = await saveProductionPlanning(f.db, 100, 10, 0, { scriptPlan: "plan v1", storyboardTable: "table v1" });
    assert.equal(first.planningVersion, 1);
    await assert.rejects(
      saveProductionPlanning(f.db, 100, 10, 0, { scriptPlan: "stale plan", storyboardTable: "stale table" }),
      (error: unknown) => error instanceof ProductionFlowError && error.status === 409,
    );
    const saved = await f.db("o_agentWorkData").where({ projectId: 100, episodesId: 10, key: "productionAgent" }).first();
    assert.deepEqual(JSON.parse(saved.data), { scriptPlan: "plan v1", storyboardTable: "table v1", planningVersion: 1 });
  });

  it("rejects cross-project storyboard sorting and rolls back the planning transaction", async () => {
    await f.db("o_storyboard").insert([
      { id: 801, projectId: 100, scriptId: 10, index: 0, duration: "2", prompt: "owned", state: "未生成", track: "A", trackId: null },
      // Deliberately corrupted row: same script id, different project.
      { id: 802, projectId: 200, scriptId: 10, index: 1, duration: "2", prompt: "foreign", state: "未生成", track: "B", trackId: null },
    ]);
    await assert.rejects(
      saveProductionPlanning(f.db, 100, 10, 0, {
        scriptPlan: "must rollback",
        storyboardTable: "must rollback",
        storyboard: [{ id: 802, collaboration: { version: 0 } }, { id: 801, collaboration: { version: 0 } }],
      }),
      (error: unknown) => error instanceof ProductionFlowError && error.status === 409,
    );
    assert.deepEqual(await f.db("o_storyboard").whereIn("id", [801, 802]).orderBy("id").select("id", "projectId", "index"), [
      { id: 801, projectId: 100, index: 0 }, { id: 802, projectId: 200, index: 1 },
    ]);
    assert.equal(await f.db("o_agentWorkData").where({ projectId: 100, episodesId: 10, key: "productionAgent" }).first(), undefined);
  });
  it("saves planning without rewriting an unchanged locked legacy order", async () => {
    await f.db("o_storyboard").insert({ id: 901, projectId: 100, scriptId: 10, index: null, duration: "2", prompt: "locked", state: "未生成" });
    const state = await new ProductionStateService(f.db).acquireLock({ projectId: 100, storyboardId: 901, expectedVersion: 0, actor: { id: "human:7", kind: "human" } });
    const result = await saveProductionPlanning(f.db, 100, 10, 0, { scriptPlan: "safe planning", storyboardTable: "", storyboard: [{ id: 901, collaboration: { version: state.state.version } }] });
    assert.equal(result.planningVersion, 1);
    assert.equal((await f.db("o_storyboard").where({ id: 901 }).first()).index, null);
  });

  it("normalizes all sparse indexes when a reorder changes their relative order", async () => {
    await f.db("o_storyboard").insert([10, 20, 30].map((index, i) => ({ id: 910 + i, projectId: 100, scriptId: 10, index, duration: "2", prompt: "order", state: "未生成" })));
    await saveProductionPlanning(f.db, 100, 10, 0, { scriptPlan: "", storyboardTable: "", storyboard: [912, 911, 910].map(id => ({ id, collaboration: { version: 0 } })) });
    assert.deepEqual((await f.db("o_storyboard").where({ scriptId: 10 }).orderBy("index")).map(row => row.id), [912, 911, 910]);
  });

});
