import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureImageFlowWorkspaceSchema, createImageFlow, uploadImageFlowMedia } from "../src/services/imageFlowWorkspace";
import sharp from "sharp";
import {
  createOrUpdateDerivedAsset,
  deleteDerivedAsset,
  ensureProductionAssetSchema,
  ProductionAssetError,
  updateDerivedAssetImage,
} from "../src/services/productionAssets";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const human = { id: "human:1", kind: "human" as const };

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureProductionAssetSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { name: "P", userId: 1 });
  const [otherProjectId] = await insertRowsReturningIds(f.db, "o_project", { name: "Other", userId: 1 });
  const [scriptId, otherScriptId] = await insertRowsReturningIds(f.db, "o_script", [
    { projectId, name: "Episode", content: "one" },
    { projectId, name: "Other episode", content: "two" },
  ]);
  const [foreignScriptId] = await insertRowsReturningIds(f.db, "o_script", { projectId: otherProjectId, name: "Foreign", content: "foreign" });
  const [parentId, secondParentId] = await insertRowsReturningIds(f.db, "o_assets", [
    { projectId, name: "Hero", type: "role", describe: "hero" },
    { projectId, name: "Room", type: "scene", describe: "room" },
  ]);
  const [foreignParentId] = await insertRowsReturningIds(f.db, "o_assets", { projectId: otherProjectId, name: "Foreign", type: "role" });
  await f.db("o_scriptAssets").insert([
    { scriptId, assetId: parentId },
    { scriptId, assetId: secondParentId },
    { scriptId: otherScriptId, assetId: parentId },
    { scriptId: foreignScriptId, assetId: foreignParentId },
  ]);
  return { ...f, projectId, otherProjectId, scriptId, otherScriptId, foreignScriptId, parentId, secondParentId, foreignParentId };
}

test("derived create returns real versioned ID and stable-key retries reuse one row", options, async () => {
  const f = await fixture();
  try {
    const input = {
      projectId: f.projectId,
      scriptId: f.scriptId,
      parentAssetId: f.parentId,
      name: "Hero winter",
      description: "winter coat",
      idempotencyKey: "derived-create-1",
      actor: human,
    };
    const created = await createOrUpdateDerivedAsset(f.db, input);
    const replay = await createOrUpdateDerivedAsset(f.db, input);
    assert.equal(created.created, true);
    assert.equal(created.version, 1);
    assert.equal(replay.reused, true);
    assert.equal(replay.id, created.id);
    assert.equal(await f.db("o_assets").where({ assetsId: f.parentId, name: "Hero winter" }).count("id as count").first().then((row: any) => Number(row?.count)), 1);
    assert.ok(await f.db("o_scriptAssets").where({ scriptId: f.scriptId, assetId: created.id }).first());
    assert.deepEqual(await f.db("ext_creative_state").where({ entityType: "asset", entityId: created.id }).first().then((row: any) => ({ version: Number(row.version), updatedBy: row.updatedBy })), { version: 1, updatedBy: human.id });
    await assert.rejects(
      createOrUpdateDerivedAsset(f.db, { ...input, name: "different" }),
      (error: any) => error instanceof ProductionAssetError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await f.destroy();
  }
});

test("existing derived edits require CAS and reject wrong project, episode, parent, and concurrent stale writers", options, async () => {
  const f = await fixture();
  try {
    const child = await createOrUpdateDerivedAsset(f.db, { projectId: f.projectId, scriptId: f.scriptId, parentAssetId: f.parentId, name: "Child", description: "v1" });
    await assert.rejects(
      createOrUpdateDerivedAsset(f.db, { projectId: f.projectId, scriptId: f.scriptId, parentAssetId: f.parentId, id: child.id, name: "No version", description: "bad" }),
      (error: any) => error instanceof ProductionAssetError && error.code === "INVALID_INPUT",
    );
    const updated = await createOrUpdateDerivedAsset(f.db, {
      projectId: f.projectId,
      scriptId: f.scriptId,
      parentAssetId: f.parentId,
      id: child.id,
      expectedVersion: 1,
      name: "Child v2",
      description: "v2",
      idempotencyKey: "derived-update-1",
      actor: human,
    });
    assert.equal(updated.version, 2);
    assert.equal((await f.db("o_assets").where({ id: child.id }).first()).name, "Child v2");
    await assert.rejects(
      createOrUpdateDerivedAsset(f.db, { projectId: f.projectId, scriptId: f.scriptId, parentAssetId: f.parentId, id: child.id, expectedVersion: 1, name: "stale", description: "stale", actor: human }),
      (error: any) => error instanceof ProductionAssetError && error.code === "VERSION_CONFLICT",
    );
    await assert.rejects(
      createOrUpdateDerivedAsset(f.db, { projectId: f.otherProjectId, scriptId: f.foreignScriptId, parentAssetId: f.foreignParentId, id: child.id, expectedVersion: 2, name: "foreign", description: "foreign", actor: human }),
      (error: any) => error instanceof ProductionAssetError && error.code === "PROJECT_MISMATCH",
    );
    await assert.rejects(
      createOrUpdateDerivedAsset(f.db, { projectId: f.projectId, scriptId: f.otherScriptId, parentAssetId: f.parentId, id: child.id, expectedVersion: 2, name: "other episode", description: "bad", actor: human }),
      (error: any) => error instanceof ProductionAssetError && error.code === "PROJECT_MISMATCH",
    );
    await assert.rejects(
      createOrUpdateDerivedAsset(f.db, { projectId: f.projectId, scriptId: f.scriptId, parentAssetId: f.secondParentId, id: child.id, expectedVersion: 2, name: "wrong parent", description: "bad", actor: human }),
      (error: any) => error instanceof ProductionAssetError && error.code === "PROJECT_MISMATCH",
    );
    const races = await Promise.allSettled([
      createOrUpdateDerivedAsset(f.db, { projectId: f.projectId, scriptId: f.scriptId, parentAssetId: f.parentId, id: child.id, expectedVersion: 2, name: "winner one", description: "one", actor: human }),
      createOrUpdateDerivedAsset(f.db, { projectId: f.projectId, scriptId: f.scriptId, parentAssetId: f.parentId, id: child.id, expectedVersion: 2, name: "winner two", description: "two", actor: { id: "human:2", kind: "human" } }),
    ]);
    assert.equal(races.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(Number((await f.db("ext_creative_state").where({ entityType: "asset", entityId: child.id }).first()).version), 3);
  } finally {
    await f.destroy();
  }
});

test("image selection enforces URL and flow ownership while preserving candidate history", options, async () => {
  const f = await fixture();
  try {
    const child = await createOrUpdateDerivedAsset(f.db, { projectId: f.projectId, scriptId: f.scriptId, parentAssetId: f.parentId, name: "Child", description: "v1" });
    const otherChild = await createOrUpdateDerivedAsset(f.db, { projectId: f.projectId, scriptId: f.scriptId, parentAssetId: f.parentId, name: "Other child", description: "other" });
    await ensureImageFlowWorkspaceSchema(f.db);
    const flow = await createImageFlow(f.db, { projectId: f.projectId, scriptId: f.scriptId, expectedVersion: 0, nodes: [], edges: [], idempotencyKey: "derived-flow-create" }, human);
    const flowId = flow.id;
    const [foreignFlowId] = await insertRowsReturningIds(f.db, "o_imageFlow", { flowData: "{}" });
    await f.db("o_assets").where({ id: otherChild.id }).update({ flowId: foreignFlowId });
    const [foreignCandidateId] = await insertRowsReturningIds(f.db, "o_image", { assetsId: otherChild.id, filePath: `/${f.projectId}/imageFlow/${f.scriptId}/foreign.png`, type: "role", state: "已完成" });

    await assert.rejects(
      updateDerivedAssetImage(f.db, { projectId: f.projectId, scriptId: f.scriptId, id: child.id, expectedVersion: 1, flowId: foreignFlowId, url: `/${f.projectId}/imageFlow/${f.scriptId}/one.png`, actor: human }),
      (error: any) => error instanceof ProductionAssetError && error.code === "PROJECT_MISMATCH",
    );
    await assert.rejects(
      updateDerivedAssetImage(f.db, { projectId: f.projectId, scriptId: f.scriptId, id: child.id, expectedVersion: 1, flowId, url: `/${f.otherProjectId}/imageFlow/${f.scriptId}/one.png`, actor: human }),
      (error: any) => error instanceof ProductionAssetError && error.code === "PROJECT_MISMATCH",
    );
    await assert.rejects(
      updateDerivedAssetImage(f.db, { projectId: f.projectId, scriptId: f.scriptId, id: child.id, expectedVersion: 1, flowId, url: `/${f.projectId}/imageFlow/${f.scriptId}/foreign.png`, actor: human }),
      (error: any) => error instanceof ProductionAssetError && error.code === "PROJECT_MISMATCH",
    );
    assert.ok(await f.db("o_image").where({ id: foreignCandidateId }).first());

    const uploads = [];
    for (const [index, color] of ["#aa2200", "#0033aa"].entries()) {
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: color } }).png().toBuffer();
      uploads.push(await uploadImageFlowMedia(f.db, { projectId: f.projectId, scriptId: f.scriptId, base64Data: `data:image/png;base64,${bytes.toString("base64")}`, idempotencyKey: `derived-upload-${index}` }, human, { write: async () => undefined }));
    }
    const firstInput = { projectId: f.projectId, scriptId: f.scriptId, id: child.id, expectedVersion: 1, flowId, url: uploads[0].filePath, idempotencyKey: "derived-image-1", actor: human };
    const first = await updateDerivedAssetImage(f.db, firstInput);
    const replay = await updateDerivedAssetImage(f.db, firstInput);
    assert.equal(first.version, 2);
    assert.equal(replay.reused, true);
    assert.equal(replay.imageId, first.imageId);
    const second = await updateDerivedAssetImage(f.db, { ...firstInput, expectedVersion: 2, url: uploads[1].filePath, idempotencyKey: "derived-image-2" });
    assert.equal(second.version, 3);
    assert.equal(await f.db("o_image").where({ assetsId: child.id }).count("id as count").first().then((row: any) => Number(row?.count)), 2, "old candidates remain available");
    assert.ok(await f.db("o_image").where({ id: first.imageId, assetsId: child.id }).first());
    assert.equal(Number((await f.db("o_assets").where({ id: child.id }).first()).imageId), second.imageId);
  } finally {
    await f.destroy();
  }
});

test("locked references block every destructive entry and successful delete replays after rows are gone", options, async () => {
  const f = await fixture();
  try {
    const child = await createOrUpdateDerivedAsset(f.db, { projectId: f.projectId, scriptId: f.scriptId, parentAssetId: f.parentId, name: "Child", description: "v1" });
    const [flowId] = await insertRowsReturningIds(f.db, "o_imageFlow", { flowData: "{}" });
    await f.db("o_assets").where({ id: child.id }).update({ flowId });
    await f.db("o_image").insert({ assetsId: child.id, filePath: `/${f.projectId}/child.png`, type: "role", state: "已完成" });
    const [storyboardId] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "locked" });
    await f.db("o_assets2Storyboard").insert({ storyboardId, assetId: child.id });
    await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: storyboardId }).update({ locked: 1, lockedBy: human.id });
    const deletion = { projectId: f.projectId, scriptId: f.scriptId, id: child.id, expectedVersion: 1, idempotencyKey: "derived-delete-1", actor: human };
    await assert.rejects(deleteDerivedAsset(f.db, deletion), (error: any) => error instanceof ProductionAssetError && error.code === "LOCKED");
    assert.ok(await f.db("o_assets").where({ id: child.id }).first());
    assert.ok(await f.db("o_scriptAssets").where({ scriptId: f.scriptId, assetId: child.id }).first());
    assert.ok(await f.db("o_image").where({ assetsId: child.id }).first());

    await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: storyboardId }).update({ locked: 0, lockedBy: null });
    const deleted = await deleteDerivedAsset(f.db, deletion);
    const replay = await deleteDerivedAsset(f.db, deletion);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.version, 2);
    assert.equal(replay.reused, true);
    assert.equal(await f.db("o_assets").where({ id: child.id }).first(), undefined);
    assert.equal(await f.db("o_image").where({ assetsId: child.id }).first(), undefined);
    assert.equal(await f.db("o_scriptAssets").where({ assetId: child.id }).first(), undefined);
    assert.equal(await f.db("o_imageFlow").where({ id: flowId }).first(), undefined);
  } finally {
    await f.destroy();
  }
});
