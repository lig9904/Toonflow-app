import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { assertImageMediaProject, MediaOwnershipError } from "../src/lib/mediaOwnership";
import {
  createImageFlow,
  ensureImageFlowWorkspaceSchema,
  ImageFlowWorkspaceError,
  presentImageFlow,
  readImageFlow,
  resolveImageFlowOwner,
  updateImageFlow,
  uploadImageFlowMedia,
  type ImageFlowStorage,
} from "../src/services/imageFlowWorkspace";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const actor = { id: "human:1", kind: "human" as const };

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureImageFlowWorkspaceSchema(f.db);
  const [projectId, otherProjectId] = await insertRowsReturningIds(f.db, "o_project", [
    { name: "Project", userId: 1 },
    { name: "Other", userId: 1 },
  ]);
  const [scriptId, secondScriptId] = await insertRowsReturningIds(f.db, "o_script", [
    { projectId, name: "Episode 1", content: "one" },
    { projectId, name: "Episode 2", content: "two" },
  ]);
  const [otherScriptId] = await insertRowsReturningIds(f.db, "o_script", {
    projectId: otherProjectId, name: "Foreign", content: "foreign",
  });
  const files = new Map<string, Buffer>();
  const writes: string[] = [];
  const storage: ImageFlowStorage = {
    write: async (path, data) => { writes.push(path); files.set(path, Buffer.from(data)); },
  };
  return { ...f, projectId, otherProjectId, scriptId, secondScriptId, otherScriptId, files, writes, storage };
}

async function pngDataUrl(color = "red") {
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 4, background: color } }).png().toBuffer();
  return { bytes, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
}

function document(image = "", prompt = "draft") {
  return {
    nodes: [
      { id: "upload-1", type: "upload", position: { x: 1, y: 2 }, data: { image } },
      { id: "generated-1", type: "generated", position: { x: 3, y: 4 }, data: { generatedImage: image, references: image ? [{ image }] : [], prompt, model: "image:model", ratio: "1:1", quality: "1K" } },
    ],
    edges: [{ id: "edge-1", source: "upload-1", target: "generated-1" }],
  };
}

test("flow upload preserves validated bytes under a stable owned key", options, async () => {
  const f = await fixture();
  try {
    const image = await pngDataUrl();
    const input = { projectId: f.projectId, scriptId: f.scriptId, base64Data: image.dataUrl, idempotencyKey: "flow-upload-one" };
    const first = await uploadImageFlowMedia(f.db, input, actor, f.storage);
    const replay = await uploadImageFlowMedia(f.db, input, actor, f.storage);
    const contentReplay = await uploadImageFlowMedia(f.db, { ...input, idempotencyKey: "flow-upload-two" }, actor, f.storage);
    assert.equal(replay.replayed, true);
    assert.equal(contentReplay.filePath, first.filePath);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.files.get(first.filePath), image.bytes);
    assert.match(first.filePath, new RegExp(`^/${f.projectId}/imageFlow/${f.scriptId}/uploads/[a-f0-9]{64}\\.png$`));
    const row = await f.db("ext_media_files").where({ filePath: first.filePath }).first();
    assert.deepEqual(
      { projectId: Number(row.projectId), scriptId: Number(row.scriptId), kind: row.kind, mime: row.mime, sha256: row.sha256, byteSize: Number(row.byteSize) },
      { projectId: f.projectId, scriptId: f.scriptId, kind: "image", mime: "image/png", sha256: first.sha256, byteSize: image.bytes.length },
    );
    await f.db("o_video").insert({ projectId: f.otherProjectId, scriptId: f.otherScriptId, filePath: first.filePath, state: "已完成" });
    await assert.rejects(
      assertImageMediaProject(f.db, f.projectId, first.filePath),
      (error: any) => error instanceof MediaOwnershipError && error.code === "AMBIGUOUS_OWNER",
    );
    await f.db("o_video").where({ projectId: f.otherProjectId, filePath: first.filePath }).delete();
    await assert.rejects(
      uploadImageFlowMedia(f.db, { ...input, base64Data: "data:image/png;base64,AAAA", idempotencyKey: "flow-upload-bad" }, actor, f.storage),
      (error: any) => error instanceof ImageFlowWorkspaceError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      uploadImageFlowMedia(f.db, { ...input, scriptId: f.otherScriptId, idempotencyKey: "flow-upload-foreign" }, actor, f.storage),
      (error: any) => error instanceof ImageFlowWorkspaceError && error.code === "PROJECT_MISMATCH",
    );
    assert.equal(f.writes.length, 1);
  } finally { await f.destroy(); }
});

test("new unbound flows keep project and episode ownership with CAS and idempotency", options, async () => {
  const f = await fixture();
  try {
    const uploaded = await uploadImageFlowMedia(f.db, {
      projectId: f.projectId, scriptId: f.scriptId, base64Data: (await pngDataUrl()).dataUrl, idempotencyKey: "flow-media-create",
    }, actor, f.storage);
    const createInput = {
      projectId: f.projectId, scriptId: f.scriptId, expectedVersion: 0 as const, idempotencyKey: "flow-create-one",
      ...document(`/oss${uploaded.filePath}?size=20`),
    };
    const created = await createImageFlow(f.db, createInput, actor);
    const replay = await createImageFlow(f.db, createInput, actor);
    assert.equal(created.version, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.flowId, created.flowId);
    assert.deepEqual(await resolveImageFlowOwner(f.db, created.flowId), {
      flowId: created.flowId, projectId: f.projectId, scriptId: f.scriptId,
    });
    const read = await readImageFlow(f.db, { id: created.flowId, projectId: f.projectId, scriptId: f.scriptId });
    assert.equal(read.version, 1);
    assert.equal((read.nodes[0] as any).data.image, uploaded.filePath);
    const presented = await presentImageFlow(read, async (path) => `/oss${path}?size=20`);
    assert.equal((presented.nodes[0] as any).data.image, `/oss${uploaded.filePath}?size=20`);
    assert.equal(presented.id, created.flowId);
    await assert.rejects(
      readImageFlow(f.db, { id: created.flowId, projectId: f.projectId, scriptId: f.secondScriptId }),
      (error: any) => error instanceof ImageFlowWorkspaceError && error.code === "PROJECT_MISMATCH",
    );

    const foreign = await uploadImageFlowMedia(f.db, {
      projectId: f.otherProjectId, scriptId: f.otherScriptId, base64Data: (await pngDataUrl("blue")).dataUrl, idempotencyKey: "flow-media-foreign",
    }, actor, f.storage);
    await assert.rejects(
      updateImageFlow(f.db, {
        flowId: created.flowId, projectId: f.projectId, scriptId: f.scriptId, expectedVersion: 1, idempotencyKey: "flow-update-foreign",
        ...document(foreign.filePath),
      }, actor),
      (error: any) => error instanceof ImageFlowWorkspaceError && error.code === "PROJECT_MISMATCH",
    );
    assert.equal((await readImageFlow(f.db, { id: created.flowId, projectId: f.projectId, scriptId: f.scriptId })).version, 1);

    const updateInput = {
      flowId: created.flowId, projectId: f.projectId, scriptId: f.scriptId, expectedVersion: 1, idempotencyKey: "flow-update-one",
      ...document(uploaded.filePath, "saved draft"),
    };
    const updated = await updateImageFlow(f.db, updateInput, actor);
    const updateReplay = await updateImageFlow(f.db, updateInput, actor);
    assert.equal(updated.version, 2);
    assert.equal(updateReplay.replayed, true);
    await assert.rejects(
      updateImageFlow(f.db, { ...updateInput, ...document(uploaded.filePath, "different") }, actor),
      (error: any) => error instanceof ImageFlowWorkspaceError && error.code === "IDEMPOTENCY_CONFLICT",
    );
    const after = await readImageFlow(f.db, { id: created.flowId, projectId: f.projectId, scriptId: f.scriptId });
    assert.equal(after.version, 2);
    assert.equal((after.nodes[1] as any).data.prompt, "saved draft");
    await f.db("o_storyboard").insert({ projectId: f.otherProjectId, scriptId: f.otherScriptId, flowId: created.flowId, prompt: "conflict", state: "已完成", index: 1 });
    await assert.rejects(
      resolveImageFlowOwner(f.db, created.flowId),
      (error: any) => error instanceof ImageFlowWorkspaceError && error.code === "AMBIGUOUS_OWNER",
    );
  } finally { await f.destroy(); }
});

test("concurrent flow updates have one winner and preserve a complete document", options, async () => {
  const f = await fixture();
  try {
    const created = await createImageFlow(f.db, {
      projectId: f.projectId, scriptId: f.scriptId, expectedVersion: 0, idempotencyKey: "flow-race-create", ...document(),
    }, actor);
    const results = await Promise.allSettled(["winner-a", "winner-b"].map((prompt) => updateImageFlow(f.db, {
      flowId: created.flowId,
      projectId: f.projectId,
      scriptId: f.scriptId,
      expectedVersion: 1,
      idempotencyKey: `flow-race-${prompt}`,
      ...document("", prompt),
    }, actor)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const current = await readImageFlow(f.db, { id: created.flowId, projectId: f.projectId, scriptId: f.scriptId });
    assert.equal(current.version, 2);
    assert.ok(["winner-a", "winner-b"].includes((current.nodes[1] as any).data.prompt));
    assert.ok(await f.db("o_imageFlow").where({ id: created.flowId }).first());
  } finally { await f.destroy(); }
});

test("legacy owner backfill requires one real asset or storyboard scope", options, async () => {
  const f = await fixture();
  try {
    const [legacyFlowId, ambiguousFlowId, orphanFlowId] = await insertRowsReturningIds(f.db, "o_imageFlow", [
      { flowData: JSON.stringify(document()) },
      { flowData: JSON.stringify(document()) },
      { flowData: JSON.stringify(document()) },
    ]);
    await f.db("o_storyboard").insert([
      { projectId: f.projectId, scriptId: f.scriptId, flowId: legacyFlowId, prompt: "legacy", state: "已完成", index: 1 },
      { projectId: f.projectId, scriptId: f.scriptId, flowId: ambiguousFlowId, prompt: "one", state: "已完成", index: 2 },
      { projectId: f.projectId, scriptId: f.secondScriptId, flowId: ambiguousFlowId, prompt: "two", state: "已完成", index: 3 },
    ]);
    assert.deepEqual(await resolveImageFlowOwner(f.db, legacyFlowId), {
      flowId: legacyFlowId, projectId: f.projectId, scriptId: f.scriptId,
    });
    assert.equal(await f.db("ext_image_flow_owners").where({ flowId: legacyFlowId }).count("flowId as count").first().then((row: any) => Number(row.count)), 0);
    const legacy = await readImageFlow(f.db, { id: legacyFlowId, projectId: f.projectId, scriptId: f.scriptId });
    assert.equal(legacy.version, 0);
    assert.equal(await f.db("ext_image_flow_owners").where({ flowId: legacyFlowId }).count("flowId as count").first().then((row: any) => Number(row.count)), 0);
    const migrated = await updateImageFlow(f.db, {
      flowId: legacyFlowId,
      projectId: f.projectId,
      scriptId: f.scriptId,
      expectedVersion: 0,
      idempotencyKey: "legacy-flow-update",
      ...document("", "migrated"),
    }, actor);
    assert.equal(migrated.version, 1);
    assert.ok(await f.db("ext_image_flow_owners").where({ flowId: legacyFlowId }).first());
    await assert.rejects(resolveImageFlowOwner(f.db, ambiguousFlowId), (error: any) => error.code === "AMBIGUOUS_OWNER");
    await assert.rejects(resolveImageFlowOwner(f.db, orphanFlowId), (error: any) => error.code === "AMBIGUOUS_OWNER");
    const count = await f.db("ext_image_flow_owners").whereIn("flowId", [ambiguousFlowId, orphanFlowId]).count("flowId as count").first();
    assert.equal(Number(count?.count), 0);
  } finally { await f.destroy(); }
});
