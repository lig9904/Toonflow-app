import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { ensureCreativeWorkspaceSchema } from "../src/services/creativeWorkspace";
import { ensureProductionStateSchema } from "../src/services/productionState";
import { ensureVideoModeIntentSchema } from "../src/services/videoModeResolution";
import { ensureProductionImageJobSchema } from "../src/services/imageJobs/runtime";
import { applyIndependentStoryboardTracks, listArchivedSharedTracks, planIndependentStoryboardTracks } from "../src/services/storyboardTrackIndependence";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const actor = { id: "human:1", kind: "human" as const };

test("plan/apply splits only shared tracks while preserving source history and storyboard identity", options, async () => {
  const fixture = await createPostgresFixture();
  try {
    await migratePostgresFixture(fixture.db); await ensureCreativeWorkspaceSchema(fixture.db); await ensureProductionStateSchema(fixture.db); await ensureVideoModeIntentSchema(fixture.db); await ensureProductionImageJobSchema(fixture.db);
    const [project] = await fixture.db("o_project").insert({ userId: 1, name: "split" }).returning("id"), projectId = Number(project.id);
    const [script] = await fixture.db("o_script").insert({ projectId, name: "episode" }).returning("id"), scriptId = Number(script.id);
    const [shared] = await fixture.db("o_videoTrack").insert({ projectId, scriptId, duration: 7, prompt: "整段人工提示词", state: "已完成" }).returning("id"), sharedTrackId = Number(shared.id);
    const [independent] = await fixture.db("o_videoTrack").insert({ projectId, scriptId, duration: 5, prompt: "独立提示词" }).returning("id"), independentTrackId = Number(independent.id);
    const boardRows = await fixture.db("o_storyboard").insert([
      { projectId, scriptId, trackId: sharedTrackId, track: "默认轨道", index: 0, duration: "3", prompt: "A", filePath: "/a.png" },
      { projectId, scriptId, trackId: sharedTrackId, track: "默认轨道", index: 1, duration: "4", prompt: "B", filePath: "/b.png" },
      { projectId, scriptId, trackId: independentTrackId, track: "默认轨道", index: 2, duration: "5", prompt: "C", filePath: "/c.png" },
    ]).returning("id");
    const boardIds = boardRows.slice(0, 2).map((row) => Number(row.id));
    await fixture.db("o_assets").insert({ id: 777, projectId, name: "prop", type: "tool" }); await fixture.db("o_assets2Storyboard").insert({ storyboardId: boardIds[0], assetId: 777 });
    await fixture.db("o_video").insert({ projectId, scriptId, videoTrackId: sharedTrackId, state: "已完成", filePath: "/history.mp4", errorReason: "" });
    await fixture.db("ext_video_mode_intents").insert({ projectId, scriptId, trackId: sharedTrackId, revision: 4, modeIntent: JSON.stringify("startEndRequired"), references: JSON.stringify([]), referencesInitialized: true, promptReferenceRevision: 3, updatedBy: "human:1", updatedAt: 1 });
    await fixture.db("ext_entity_state").where({ projectId, entityType: "storyboard", entityId: boardIds[0] }).update({ version: 17, internalMutation: null });
    const [staleJob] = await fixture.db("ext_image_jobs").insert({ idempotencyKey: "stale-image", payloadHash: "hash", modelKey: "fixture:image", projectId, outputPath: "/stale.png", payload: "{}", status: "RESERVED", createdAt: 1, updatedAt: 1 }).returning("id");
    await fixture.db("ext_image_job_bindings").insert({ jobId: staleJob.id, projectId, scriptId, targetKind: "storyboard", targetId: String(boardIds[0]), expectedVersion: 2, claimVersion: 3, claimToken: "image-job:stale", targetSignature: "old", selected: true, state: "RESERVED", createdAt: 1, updatedAt: 1 });
    const plan = await planIndependentStoryboardTracks(fixture.db, { projectId, scriptId });
    assert.equal(plan.blocked, false); assert.equal(plan.groups.length, 1); assert.equal(plan.groups[0].sourceTrackId, sharedTrackId); assert.equal(plan.groups[0].ignoredStaleImageJobs, 1); assert.equal("snapshot" in plan.groups[0], false, "plan API must not expose raw rows or job payloads");
    const applied = await applyIndependentStoryboardTracks(fixture.db, { projectId, scriptId, planHash: plan.planHash, idempotencyKey: "split-shared-track" }, actor);
    assert.equal(applied.createdTrackCount, 2); assert.equal(new Set(applied.mappings.map((item: any) => item.newTrackId)).size, 2);
    const moved = await fixture.db("o_storyboard").whereIn("id", boardIds).orderBy("id"); assert.deepEqual(moved.map((row) => Number(row.id)), boardIds); assert.equal(new Set(moved.map((row) => Number(row.trackId))).size, 2);
    assert.deepEqual((await fixture.db("o_videoTrack").whereIn("id", moved.map((row) => row.trackId)).orderBy("duration")).map((row) => Number(row.duration)), [3, 4]);
    assert.equal((await fixture.db("o_storyboard").where({ id: boardIds[0] }).first()).filePath, "/a.png"); assert.equal((await fixture.db("o_assets2Storyboard").where({ storyboardId: boardIds[0] }).first()).assetId, 777);
    assert.equal((await fixture.db("o_videoTrack").where({ id: sharedTrackId }).first()).prompt, "整段人工提示词"); assert.equal((await fixture.db("o_video").where({ videoTrackId: sharedTrackId }).first()).filePath, "/history.mp4"); assert.equal((await fixture.db("ext_video_mode_intents").where({ trackId: sharedTrackId }).first()).revision, 4);
    assert.equal((await fixture.db("ext_image_jobs").where({ id: staleJob.id }).first()).status, "RESERVED", "migration must not rewrite stale historical jobs");
    assert.equal(await fixture.db("ext_video_mode_intents").whereIn("trackId", moved.map((row) => row.trackId)).first(), undefined, "new shot tracks default to auto without copying the old selection");
    assert.equal((await fixture.db("o_storyboard").where({ trackId: independentTrackId }).first()).prompt, "C");
    const archive = (await listArchivedSharedTracks(fixture.db, projectId, scriptId))[0]; assert.equal(archive.prompt, "整段人工提示词"); assert.equal(archive.videos[0].filePath, "/history.mp4"); assert.equal((archive as any).snapshot, undefined);
    const replay = await applyIndependentStoryboardTracks(fixture.db, { projectId, scriptId, planHash: plan.planHash, idempotencyKey: "split-shared-track" }, actor); assert.equal(replay.reused, true); assert.equal(replay.createdTrackCount, 2);
  } finally { await fixture.destroy(); }
});

test("plan blocks locked or cross-scope shared tracks and leaves every row unchanged", options, async () => {
  const fixture = await createPostgresFixture();
  try {
    await migratePostgresFixture(fixture.db); await ensureCreativeWorkspaceSchema(fixture.db); await ensureProductionStateSchema(fixture.db);
    const [project] = await fixture.db("o_project").insert({ userId: 1, name: "blocked" }).returning("id"), projectId = Number(project.id);
    const [other] = await fixture.db("o_project").insert({ userId: 1, name: "foreign" }).returning("id"), otherProjectId = Number(other.id);
    const [script] = await fixture.db("o_script").insert({ projectId, name: "episode" }).returning("id"), scriptId = Number(script.id);
    const [otherScript] = await fixture.db("o_script").insert({ projectId: otherProjectId, name: "foreign" }).returning("id"), otherScriptId = Number(otherScript.id);
    const [track] = await fixture.db("o_videoTrack").insert({ projectId, scriptId, duration: 4 }).returning("id"), trackId = Number(track.id);
    const rows = await fixture.db("o_storyboard").insert([{ projectId, scriptId, trackId, index: 0, duration: "2" }, { projectId, scriptId, trackId, index: 1, duration: "2" }]).returning("id");
    await fixture.db("ext_entity_state").insert({ entityType: "storyboard", entityId: Number(rows[0].id), projectId, version: 0, reviewState: "draft", locked: 1, lockedBy: "human:1" }).onConflict(["entityType", "entityId"]).merge({ locked: 1, lockedBy: "human:1" });
    await fixture.db("o_storyboard").insert({ projectId: otherProjectId, scriptId: otherScriptId, trackId, index: 0, duration: "2" });
    const plan = await planIndependentStoryboardTracks(fixture.db, { projectId, scriptId }); assert.equal(plan.blocked, true); assert.match(plan.groups[0].reasons.join(" "), /锁定|跨项目/);
    await assert.rejects(applyIndependentStoryboardTracks(fixture.db, { projectId, scriptId, planHash: plan.planHash, idempotencyKey: "blocked-shared-track" }, actor), (error: any) => error.code === "MIGRATION_BLOCKED");
    assert.equal(Number((await fixture.db("o_storyboard").where({ projectId, scriptId, trackId }).count("id as count").first())?.count ?? 0), 2);
  } finally { await fixture.destroy(); }
});
