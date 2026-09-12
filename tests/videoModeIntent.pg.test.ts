import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { acknowledgeVideoPromptReferences, captureVideoModeSelectionSnapshot, claimVideoModeSelectionForSubmission, ensureVideoModeIntentSchema, readVideoModeIntent, reloadStoryboardTrackReferences, resolveStoredVideoMode, revalidateVideoModeSelection, saveVideoModeIntent, saveVideoReferences } from "../src/services/videoModeResolution";
import { ensureCreativeWorkspaceSchema } from "../src/services/creativeWorkspace";
import { ensureProductionStateSchema } from "../src/services/productionState";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };

test("project mode stays a legacy default while every track without an explicit receipt defaults to auto", options, async () => {
  const fixture = await createPostgresFixture();
  try {
    await migratePostgresFixture(fixture.db);
    const [projectId] = await insertRowsReturningIds(fixture.db, "o_project", { userId: 1, name: "mode intent", mode: "singleImage" });
    const [scriptId] = await insertRowsReturningIds(fixture.db, "o_script", { projectId, name: "episode", content: "scene" });
    const [oldTrack] = await insertRowsReturningIds(fixture.db, "o_videoTrack", { projectId, scriptId, prompt: "human prompt" });
    await ensureVideoModeIntentSchema(fixture.db);
    assert.deepEqual(await readVideoModeIntent(fixture.db, { projectId, scriptId, trackId: oldTrack }), { trackId: oldTrack, modeIntent: "auto", references: [], referencesInitialized: false, referenceSourceSnapshot: [], promptReferenceRevision: 0, revision: 0, source: "default" });
    const [newTrack] = await insertRowsReturningIds(fixture.db, "o_videoTrack", { projectId, scriptId, prompt: "new human prompt" });
    assert.deepEqual(await readVideoModeIntent(fixture.db, { projectId, scriptId, trackId: newTrack }), { trackId: newTrack, modeIntent: "auto", references: [], referencesInitialized: false, referenceSourceSnapshot: [], promptReferenceRevision: 0, revision: 0, source: "default" });
    const saved = await saveVideoModeIntent(fixture.db, { projectId, scriptId, trackId: newTrack, modeIntent: ["imageReference:4", "videoReference:1"], expectedRevision: 0, idempotencyKey: "save-track-mode-one" }, "human:1");
    assert.equal(saved.revision, 1); assert.deepEqual(saved.modeIntent, ["imageReference:4", "videoReference:1"]); assert.equal((await saveVideoModeIntent(fixture.db, { projectId, scriptId, trackId: newTrack, modeIntent: ["imageReference:4", "videoReference:1"], expectedRevision: 0, idempotencyKey: "save-track-mode-one" }, "human:1")).reused, true);
    await assert.rejects(saveVideoModeIntent(fixture.db, { projectId, scriptId, trackId: newTrack, modeIntent: "text", expectedRevision: 0, idempotencyKey: "save-track-mode-stale" }, "human:1"), (error: any) => error.code === "MODE_INTENT_CONFLICT");
  } finally { await fixture.destroy(); }
});

test("selected unavailable media fails instead of silently resolving to text", options, async () => {
  const fixture = await createPostgresFixture();
  try {
    await migratePostgresFixture(fixture.db);
    const [projectId] = await insertRowsReturningIds(fixture.db, "o_project", { userId: 1, name: "missing mode ref", mode: "auto" });
    const [scriptId] = await insertRowsReturningIds(fixture.db, "o_script", { projectId, name: "episode", content: "scene" });
    const [trackId] = await insertRowsReturningIds(fixture.db, "o_videoTrack", { projectId, scriptId, prompt: "keep me" });
    await assert.rejects(resolveStoredVideoMode(fixture.db, { projectId, scriptId, trackId, model: "fixture:video", capabilities: { mode: ["text", "singleImage"] }, references: [{ id: 99999, sources: "storyboard", fileType: "image", purpose: "first_frame" }] }), (error: any) => error.code === "REFERENCE_UNAVAILABLE");
    assert.equal((await fixture.db("o_videoTrack").where({ id: trackId }).first()).prompt, "keep me");
  } finally { await fixture.destroy(); }
});

test("one shared revision protects stored reference purposes, prompt acknowledgement and pre-submit order", options, async () => {
  const fixture = await createPostgresFixture();
  try {
    await migratePostgresFixture(fixture.db);
    const [projectId] = await insertRowsReturningIds(fixture.db, "o_project", { userId: 1, name: "selection CAS", mode: "text" });
    const [scriptId] = await insertRowsReturningIds(fixture.db, "o_script", { projectId, name: "episode", content: "scene" });
    const [trackId] = await insertRowsReturningIds(fixture.db, "o_videoTrack", { projectId, scriptId, prompt: "human prompt" });
    const [otherTrackId] = await insertRowsReturningIds(fixture.db, "o_videoTrack", { projectId, scriptId, prompt: "other track" });
    const [firstId, lastId] = await insertRowsReturningIds(fixture.db, "o_storyboard", [
      { projectId, scriptId, trackId, index: 0, filePath: "/first.png", prompt: "first" },
      { projectId, scriptId, trackId: otherTrackId, index: 1, filePath: "/last.png", prompt: "last" },
    ]);
    const stored = await saveVideoReferences(fixture.db, { projectId, scriptId, trackId, references: [{ id: lastId, sources: "storyboard", fileType: "image", purpose: "last_frame" }, { id: firstId, sources: "storyboard", fileType: "image", purpose: "first_frame" }], expectedRevision: 0, idempotencyKey: "save-frame-purposes" }, "human:1");
    assert.equal(stored.revision, 1); assert.deepEqual(stored.references.map((item: any) => item.purpose), ["last_frame", "first_frame"]);
    const selected = await saveVideoModeIntent(fixture.db, { projectId, scriptId, trackId, modeIntent: "startEndRequired", expectedRevision: 1, idempotencyKey: "save-frame-mode" }, "human:1");
    assert.equal(selected.revision, 2); assert.equal(selected.promptReferenceRevision, 0);
    await assert.rejects(acknowledgeVideoPromptReferences(fixture.db, { projectId, scriptId, trackId, expectedRevision: 1 }, "human:2"), (error: any) => error.code === "MODE_INTENT_CONFLICT");
    assert.equal((await readVideoModeIntent(fixture.db, { projectId, scriptId, trackId })).promptReferenceRevision, 0);
    assert.equal(await acknowledgeVideoPromptReferences(fixture.db, { projectId, scriptId, trackId, expectedRevision: 2 }, "human:2"), 2);
    const resolution = await resolveStoredVideoMode(fixture.db, { projectId, scriptId, trackId, model: "fixture:video", capabilities: { mode: ["startEndRequired"] }, references: selected.references, expectedIntentRevision: 2 });
    assert.deepEqual(resolution.resolvedReferences.map((item) => item.purpose), ["first_frame", "last_frame"]);
    let contentGeneration = "original";
    const readContent = async (filePath: string) => `bytes:${filePath}:${contentGeneration}`;
    const snapshot = await captureVideoModeSelectionSnapshot(fixture.db, { projectId, scriptId, trackId, resolution }, readContent);
    await revalidateVideoModeSelection(fixture.db, { projectId, scriptId, trackId, snapshot }, readContent);
    contentGeneration = "replaced-same-path";
    await assert.rejects(revalidateVideoModeSelection(fixture.db, { projectId, scriptId, trackId, snapshot }, readContent), (error: any) => error.submissionOutcome === "not_submitted");
    contentGeneration = "original";
    await fixture.db("o_storyboard").where({ id: firstId }).update({ filePath: "/first-replaced.png" });
    await assert.rejects(revalidateVideoModeSelection(fixture.db, { projectId, scriptId, trackId, snapshot }, async (filePath) => `bytes:${filePath}`), (error: any) => error.submissionOutcome === "not_submitted");
    await fixture.db("o_storyboard").where({ id: firstId }).update({ filePath: "/first.png" });
    await claimVideoModeSelectionForSubmission(fixture.db, { jobId: 123, projectId, scriptId, trackId, snapshot }, readContent);
    assert.equal((await fixture.db("ext_video_mode_submission_claims").where({ jobId: 123 }).first()).selectionRevision, 2);
    await assert.rejects(resolveStoredVideoMode(fixture.db, { projectId: projectId + 999, scriptId, trackId, model: "fixture:video", capabilities: { mode: ["text"] }, references: [], expectedIntentRevision: 0 }), (error: any) => error.code === "PROJECT_MISMATCH");
  } finally { await fixture.destroy(); }
});

test("reload rebuilds one shot from server-owned links, preserves manual mode and never acknowledges the changed prompt", options, async () => {
  const fixture = await createPostgresFixture();
  try {
    await migratePostgresFixture(fixture.db); await ensureCreativeWorkspaceSchema(fixture.db); await ensureProductionStateSchema(fixture.db); await ensureVideoModeIntentSchema(fixture.db);
    const [project] = await fixture.db("o_project").insert({ userId: 1, name: "reload" }).returning("id"), projectId = Number(project.id);
    const [script] = await fixture.db("o_script").insert({ projectId, name: "episode" }).returning("id"), scriptId = Number(script.id);
    const [track] = await fixture.db("o_videoTrack").insert({ projectId, scriptId, prompt: "人工正文", duration: 4 }).returning("id"), trackId = Number(track.id);
    const [board] = await fixture.db("o_storyboard").insert({ projectId, scriptId, trackId, index: 0, duration: "4", filePath: "/shot.png" }).returning("id"), storyboardId = Number(board.id);
    const [image] = await fixture.db("o_image").insert({ filePath: "/role.png", type: "role" }).returning("id"); const [asset] = await fixture.db("o_assets").insert({ projectId, name: "role", type: "role", imageId: image.id }).returning("id");
    await fixture.db("o_assets2Storyboard").insert({ storyboardId, assetId: asset.id }); await fixture.db("o_scriptAssets").insert({ scriptId, assetId: asset.id });
    await saveVideoModeIntent(fixture.db, { projectId, scriptId, trackId, modeIntent: ["imageReference:4"], expectedRevision: 0, idempotencyKey: "reload-manual-mode" }, "human:1");
    const trackVersion = Number((await fixture.db("ext_creative_state").where({ projectId, entityType: "track", entityId: trackId }).first())?.version ?? 0), storyboardVersion = Number((await fixture.db("ext_entity_state").where({ projectId, entityType: "storyboard", entityId: storyboardId }).first())?.version ?? 0);
    const readSource = async (filePath: string) => `data:image/png;base64,${Buffer.from(filePath).toString("base64")}`;
    const loaded = await reloadStoryboardTrackReferences(fixture.db, { projectId, scriptId, trackId, storyboardId, expectedTrackVersion: trackVersion, expectedStoryboardVersion: storyboardVersion, expectedModeIntentRevision: 1, idempotencyKey: "reload-one-shot" }, "human:1", readSource);
    assert.deepEqual(loaded.modeIntent, ["imageReference:4"]); assert.deepEqual(loaded.references.map((item: any) => item.purpose), ["first_frame", "identity_reference"]); assert.equal(loaded.revision, 2); assert.equal(loaded.promptReferenceRevision, 0); assert.equal(loaded.needsReview, true); assert.equal((await fixture.db("o_videoTrack").where({ id: trackId }).first()).prompt, "人工正文");
    const replay = await reloadStoryboardTrackReferences(fixture.db, { projectId, scriptId, trackId, storyboardId, expectedTrackVersion: trackVersion, expectedStoryboardVersion: storyboardVersion, expectedModeIntentRevision: 1, idempotencyKey: "reload-one-shot" }, "human:1", async () => { throw new Error("idempotent replay must not reread media"); }); assert.equal(replay.reused, true); assert.equal(replay.revision, 2);
    await fixture.db("o_storyboard").where({ id: storyboardId }).update({ filePath: "/shot-replaced.png" });
    const replacedBoardVersion = Number((await fixture.db("ext_entity_state").where({ projectId, entityType: "storyboard", entityId: storyboardId }).first())?.version ?? 0);
    const replaced = await reloadStoryboardTrackReferences(fixture.db, { projectId, scriptId, trackId, storyboardId, expectedTrackVersion: trackVersion, expectedStoryboardVersion: replacedBoardVersion, expectedModeIntentRevision: 2, idempotencyKey: "reload-one-shot-replaced" }, "human:1", readSource);
    assert.equal(replaced.changed, true); assert.equal(replaced.revision, 3); assert.equal(replaced.promptReferenceRevision, 0); assert.equal(replaced.needsReview, true);
  } finally { await fixture.destroy(); }
});
