import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { ensureTeamSchema } from "../src/services/team";
import {
  AssetWorkspaceError,
  batchDeleteAssets,
  createAsset,
  createAudioAsset,
  deleteImage,
  ensureAssetWorkspaceSchema,
  getImages,
  selectAssetImage,
  updateAsset,
  updateAudioAsset,
  uploadAsset,
  validateMedia,
  type AssetStorage,
} from "../src/services/assetWorkspace";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const actor = { id: "human:1", kind: "human" as const };

async function makeFixture() {
  const pgFixture = await createPostgresFixture();
  await migratePostgresFixture(pgFixture.db);
  await ensureTeamSchema(pgFixture.db, { bootstrapAdminUserId: 1 });
  await ensureAssetWorkspaceSchema(pgFixture.db);
  const [project] = await pgFixture.db("o_project").insert({ name: "P", userId: 1 }).returning("id");
  const [otherProject] = await pgFixture.db("o_project").insert({ name: "Other", userId: 1 }).returning("id");
  const files = new Map<string, Buffer>();
  const writes: string[] = [];
  const storage: AssetStorage = {
    write: async (path, data) => { writes.push(path); files.set(path, Buffer.from(data)); },
    delete: async (path) => { files.delete(path); },
    url: async (path) => path,
  };
  return { ...pgFixture, projectId: Number(project.id), otherProjectId: Number(otherProject.id), files, writes, storage };
}

async function pngDataUrl(color = "red") {
  const data = await sharp({ create: { width: 2, height: 2, channels: 4, background: color } }).png().toBuffer();
  return `data:image/png;base64,${data.toString("base64")}`;
}

function wavDataUrl(marker = 0): string {
  const bytes = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8, marker)]);
  return `data:audio/wav;base64,${bytes.toString("base64")}`;
}

async function addStoryboardReference(db: any, projectId: number, assetId: number, storyboardId: number, locked: boolean) {
  await db("o_storyboard").insert({ id: storyboardId, projectId, scriptId: 1, index: 0, duration: 2, prompt: "frame", state: "未生成" });
  await db("o_assets2Storyboard").insert({ storyboardId, assetId });
  if (locked) await setStoryboardLocked(db, projectId, storyboardId, true);
}

async function setStoryboardLocked(db: any, projectId: number, storyboardId: number, locked: boolean) {
  await db("ext_entity_state").insert({
    entityType: "storyboard",
    entityId: storyboardId,
    projectId,
    version: 0,
    reviewState: "draft",
    locked: locked ? 1 : 0,
    lockedBy: locked ? actor.id : null,
  }).onConflict(["entityType", "entityId"]).merge({ locked: locked ? 1 : 0, lockedBy: locked ? actor.id : null });
}

test("asset CAS, deterministic media replay, candidate ownership, and locked references", options, async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      createAsset(fixture.db, { projectId: 999999, name: "ghost", describe: "", type: "role", mutationKey: "missing-project-1" }, actor),
      (error: any) => error instanceof AssetWorkspaceError && error.code === "NOT_FOUND",
    );
    const created = await createAsset(fixture.db, { projectId: fixture.projectId, name: "hero", describe: "d", type: "role", prompt: "Keep the saved character prompt", idempotencyKey: "asset-create-1" }, actor);
    const replay = await createAsset(fixture.db, { projectId: fixture.projectId, name: "hero", describe: "d", type: "role", prompt: "Keep the saved character prompt", mutationKey: "asset-create-1" }, actor);
    assert.equal(replay.reused, true);
    assert.equal(replay.assetId, created.assetId);
    assert.equal(await fixture.db("o_assets").where({ projectId: fixture.projectId }).count("id as count").first().then((row: any) => Number(row?.count)), 1);

    const image = await pngDataUrl();
    const selected = await selectAssetImage(fixture.db, { id: created.assetId, projectId: fixture.projectId, expectedVersion: 1, idempotencyKey: "asset-image-1", type: "role", base64: image }, actor, fixture.storage);
    const selectedReplay = await selectAssetImage(fixture.db, { id: created.assetId, projectId: fixture.projectId, expectedVersion: 1, mutationKey: "asset-image-1", type: "role", base64: image }, actor, fixture.storage);
    assert.equal(selectedReplay.reused, true);
    assert.equal((await fixture.db("o_assets").where({id:created.assetId}).first()).prompt,"Keep the saved character prompt","Selecting an image without a prompt must preserve saved text");
    assert.equal(selectedReplay.imageId, selected.imageId);
    assert.equal(fixture.writes.length, 1, "a receipt replay must not stage another file");
    assert.equal(fixture.files.size, 1);

    const other = await createAsset(fixture.db, { projectId: fixture.projectId, name: "other", describe: "", type: "role", idempotencyKey: "asset-create-2" }, actor);
    const [foreignCandidate] = await fixture.db("o_image").insert({ assetsId: other.assetId, filePath: "/foreign.png", type: "role", state: "已完成" }).returning("id");
    await assert.rejects(
      selectAssetImage(fixture.db, { id: created.assetId, projectId: fixture.projectId, expectedVersion: 2, idempotencyKey: "foreign-image-1", type: "role", imageId: Number(foreignCandidate.id) }, actor, fixture.storage),
      (error: any) => error instanceof AssetWorkspaceError && error.code === "PROJECT_MISMATCH",
    );

    const replacement = await selectAssetImage(fixture.db, { id: created.assetId, projectId: fixture.projectId, expectedVersion: 2, idempotencyKey: "asset-image-2", type: "role", base64: await pngDataUrl("blue") }, actor, fixture.storage);
    const removed = await deleteImage(fixture.db, { id: selected.imageId, projectId: fixture.projectId, idempotencyKey: "delete-image-1" }, actor, fixture.storage);
    assert.equal(removed.reused, false);
    const removedReplay = await deleteImage(fixture.db, { id: selected.imageId, projectId: fixture.projectId, mutationKey: "delete-image-1" }, actor, fixture.storage);
    assert.equal(removedReplay.reused, true, "deletion replay must survive the row being absent");

    await addStoryboardReference(fixture.db, fixture.projectId, created.assetId, 7001, true);
    await assert.rejects(
      updateAsset(fixture.db, { id: created.assetId, projectId: fixture.projectId, expectedVersion: 3, idempotencyKey: "locked-update-1", name: "blocked", describe: "blocked" }, actor),
      (error: any) => error instanceof AssetWorkspaceError && error.code === "LOCKED",
    );
    assert.equal((await fixture.db("o_assets").where({ id: created.assetId }).first()).name, "hero");

    const images = await getImages(fixture.db, created.assetId);
    assert.equal(images.version, 3);
    await assert.rejects(deleteImage(fixture.db, { id: replacement.imageId, projectId: fixture.projectId, idempotencyKey: "delete-current-1" }, actor, fixture.storage), (error: any) => error.code === "REFERENCED");
  } finally {
    await fixture.destroy();
  }
});

test("audio parent and children update atomically with omit/preserve and empty/clear semantics", options, async () => {
  const fixture = await makeFixture();
  try {
    const created = await createAudioAsset(fixture.db, {
      projectId: fixture.projectId,
      name: "Narrator",
      describe: "female|calm",
      idempotencyKey: "audio-create-1",
      assetsItem: [
        { name: "take-1", describe: "first", prompt: "p1", base64: wavDataUrl(1) },
        { name: "take-2", describe: "second", prompt: "p2", base64: wavDataUrl(2) },
      ],
    }, actor, fixture.storage);
    assert.equal(created.asset.version, 1);
    assert.equal(created.children.length, 2);
    assert.deepEqual(created.children.map((item: any) => item.version), [1, 1]);
    const writesAfterCreate = fixture.writes.length;
    const replay = await createAudioAsset(fixture.db, {
      projectId: fixture.projectId,
      name: "Narrator",
      describe: "female|calm",
      mutationKey: "audio-create-1",
      assetsItem: [
        { name: "take-1", describe: "first", prompt: "p1", base64: wavDataUrl(1) },
        { name: "take-2", describe: "second", prompt: "p2", base64: wavDataUrl(2) },
      ],
    }, actor, fixture.storage);
    assert.equal(replay.reused, true);
    assert.deepEqual(replay.childIds, created.childIds);
    assert.equal(fixture.writes.length, writesAfterCreate);

    const metadataOnly = await updateAudioAsset(fixture.db, {
      id: created.assetId,
      projectId: fixture.projectId,
      expectedVersion: 1,
      idempotencyKey: "audio-metadata-1",
      name: "Narrator revised",
      describe: "female|warm",
    }, actor, fixture.storage);
    assert.deepEqual(metadataOnly.childIds, created.childIds, "omitting assetsItem preserves children");
    assert.equal(metadataOnly.asset.version, 2);

    const [foreignParent] = await fixture.db("o_assets").insert({ projectId: fixture.otherProjectId, name: "foreign", type: "audio", startTime: Date.now() }).returning("id");
    const [foreignChild] = await fixture.db("o_assets").insert({ projectId: fixture.otherProjectId, assetsId: foreignParent.id, name: "foreign child", type: "audio", startTime: Date.now() }).returning("id");
    const filesBeforeRejectedUpdate = fixture.files.size;
    await assert.rejects(
      updateAudioAsset(fixture.db, {
        id: created.assetId,
        projectId: fixture.projectId,
        expectedVersion: 2,
        idempotencyKey: "audio-foreign-1",
        assetsItem: [
          { name: "would roll back", describe: "", prompt: "", base64: wavDataUrl(3) },
          { id: Number(foreignChild.id), expectedVersion: 0, name: "bad", describe: "", prompt: "" },
        ],
      }, actor, fixture.storage),
      (error: any) => error instanceof AssetWorkspaceError && error.code === "PROJECT_MISMATCH",
    );
    assert.equal(fixture.files.size, filesBeforeRejectedUpdate, "a rejected semantic update cleans its newly staged file");
    assert.equal((await getImages(fixture.db, created.childIds[0])).version, 1);
    const remainingChildren = await fixture.db("o_assets").where({ assetsId: created.assetId }).count("id as count").first();
    assert.equal(Number(remainingChildren?.count), 2);

    const cleared = await updateAudioAsset(fixture.db, {
      id: created.assetId,
      projectId: fixture.projectId,
      expectedVersion: 2,
      mutationKey: "audio-clear-1",
      name: "Narrator revised",
      describe: "female|warm",
      assetsItem: [],
    }, actor, fixture.storage);
    assert.deepEqual(cleared.childIds, [], "an explicit empty assetsItem clears children");
    assert.equal(await fixture.db("o_assets").where({ assetsId: created.assetId }).count("id as count").first().then((row: any) => Number(row?.count)), 0);
    assert.equal(fixture.files.size, 0, "committed child removal also removes stored audio files");
  } finally {
    await fixture.destroy();
  }
});

test("batch deletion is one transaction and protects referenced or locked assets", options, async () => {
  const fixture = await makeFixture();
  try {
    const first = await createAsset(fixture.db, { projectId: fixture.projectId, name: "first", describe: "", type: "scene", idempotencyKey: "batch-first-1" }, actor);
    const second = await createAsset(fixture.db, { projectId: fixture.projectId, name: "second", describe: "", type: "scene", idempotencyKey: "batch-second-1" }, actor);
    await addStoryboardReference(fixture.db, fixture.projectId, second.assetId, 7002, false);
    const input = { projectId: fixture.projectId, ids: [first.assetId, second.assetId], expectedVersions: { [first.assetId]: 1, [second.assetId]: 1 }, idempotencyKey: "batch-delete-1" };
    await assert.rejects(batchDeleteAssets(fixture.db, input, actor, fixture.storage), (error: any) => error.code === "REFERENCED");
    assert.ok(await fixture.db("o_assets").where({ id: first.assetId }).first(), "the unreferenced row must roll back with the batch");
    assert.ok(await fixture.db("o_assets").where({ id: second.assetId }).first());

    await setStoryboardLocked(fixture.db, fixture.projectId, 7002, true);
    await assert.rejects(batchDeleteAssets(fixture.db, { ...input, idempotencyKey: "batch-delete-locked" }, actor, fixture.storage), (error: any) => error.code === "LOCKED");
    await setStoryboardLocked(fixture.db, fixture.projectId, 7002, false);
    await fixture.db("o_assets2Storyboard").where({ storyboardId: 7002, assetId: second.assetId }).delete();

    const deleted = await batchDeleteAssets(fixture.db, { ...input, mutationKey: "batch-delete-success", idempotencyKey: undefined }, actor, fixture.storage);
    assert.deepEqual(deleted.assetIds, [first.assetId, second.assetId]);
    assert.equal(await fixture.db("o_assets").whereIn("id", [first.assetId, second.assetId]).count("id as count").first().then((row: any) => Number(row?.count)), 0);
    const replay = await batchDeleteAssets(fixture.db, { ...input, mutationKey: "batch-delete-success", idempotencyKey: undefined }, actor, fixture.storage);
    assert.equal(replay.reused, true);
  } finally {
    await fixture.destroy();
  }
});

test("media validation and upload reject forged bytes and missing projects without staging", options, async () => {
  const fixture = await makeFixture();
  try {
    assert.equal((await validateMedia(await pngDataUrl("blue"))).image, true);
    await assert.rejects(validateMedia("data:image/png;base64,AAAA"));
    await assert.rejects(validateMedia("data:audio/mpeg;base64,AAAA"));
    assert.equal((await validateMedia(wavDataUrl())).ext, "wav");
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.alloc(8)]);
    const payload = { projectId: fixture.projectId, name: "clip", type: "clip", idempotencyKey: "upload-replay-1", base64Data: `data:video/mp4;base64,${mp4.toString("base64")}` };
    const first = await uploadAsset(fixture.db, payload, actor, fixture.storage);
    const replay = await uploadAsset(fixture.db, { ...payload, idempotencyKey: undefined, mutationKey: "upload-replay-1" }, actor, fixture.storage);
    assert.equal(replay.reused, true);
    assert.equal(replay.assetId, first.assetId);
    assert.equal(fixture.writes.length, 1);
    await assert.rejects(uploadAsset(fixture.db, { ...payload, projectId: 999999, idempotencyKey: "upload-missing-1" }, actor, fixture.storage), (error: any) => error.code === "NOT_FOUND");
    assert.equal(fixture.writes.length, 1, "missing project validation runs before storage.write");
  } finally {
    await fixture.destroy();
  }
});
