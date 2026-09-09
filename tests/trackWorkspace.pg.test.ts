import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { ensureTeamSchema, requireProjectAccess } from "../src/services/team";
import { ensureVideoJobsSchema, VideoJobService, type VideoJobPayload, type VideoTaskProvider } from "../src/services/videoJobs";
import {
  createTrack,
  deleteTrack,
  deleteTrackVideo,
  ensureTrackWorkspaceSchema,
  getTrackSelection,
  selectTrackVideo,
  TrackWorkspaceError,
  updateTrackDuration,
  updateTrackPrompt,
} from "../src/services/trackWorkspace";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const editorActor = { id: "human:2", kind: "human" as const };

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await f.db("o_user").insert({ id: 2, name: "editor", password: "unused" });
  await ensureTeamSchema(f.db, { bootstrapAdminUserId: 1 });
  await ensureTrackWorkspaceSchema(f.db);
  await ensureVideoJobsSchema(f.db);
  const [project] = await f.db("o_project").insert({ name: "P", userId: 1 }).returning("id");
  const [otherProject] = await f.db("o_project").insert({ name: "Other", userId: 1 }).returning("id");
  const projectId = Number(project.id);
  const otherProjectId = Number(otherProject.id);
  const [script] = await f.db("o_script").insert({ projectId, name: "Episode" }).returning("id");
  const [otherScript] = await f.db("o_script").insert({ projectId: otherProjectId, name: "Foreign" }).returning("id");
  const [track] = await f.db("o_videoTrack").insert({ projectId, scriptId: script.id, duration: 2 }).returning("id");
  const [otherTrack] = await f.db("o_videoTrack").insert({ projectId: otherProjectId, scriptId: otherScript.id, duration: 2 }).returning("id");
  const [good] = await f.db("o_video").insert({ projectId, scriptId: script.id, videoTrackId: track.id, state: "生成成功", filePath: "/good.mp4" }).returning("id");
  const [failed] = await f.db("o_video").insert({ projectId, scriptId: script.id, videoTrackId: track.id, state: "生成失败", filePath: "/failed.mp4" }).returning("id");
  const [foreign] = await f.db("o_video").insert({ projectId: otherProjectId, scriptId: otherScript.id, videoTrackId: otherTrack.id, state: "生成成功", filePath: "/foreign.mp4" }).returning("id");
  return { ...f, projectId, otherProjectId, scriptId: Number(script.id), trackId: Number(track.id), goodId: Number(good.id), failedId: Number(failed.id), foreignId: Number(foreign.id) };
}

test("shared editor selects only a successful same-track candidate and CAS failures preserve the old pointer", options, async () => {
  const f = await fixture();
  try {
    const principal = await requireProjectAccess(f.db, 2, f.projectId, "edit");
    assert.equal(principal.role, "editor");
    const selected = await selectTrackVideo(f.db, {
      projectId: f.projectId,
      scriptId: f.scriptId,
      trackId: f.trackId,
      videoId: f.goodId,
      expectedVersion: 0,
      idempotencyKey: "track-select-good",
    }, editorActor);
    assert.equal(selected.track.videoId, f.goodId);
    assert.equal(selected.track.version, 1);

    await assert.rejects(selectTrackVideo(f.db, {
      projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId, videoId: f.failedId,
      expectedVersion: 1, idempotencyKey: "track-select-failed",
    }, editorActor), (error: any) => error instanceof TrackWorkspaceError && error.code === "INVALID_INPUT");
    assert.equal((await getTrackSelection(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId })).videoId, f.goodId);

    await assert.rejects(selectTrackVideo(f.db, {
      projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId, videoId: f.foreignId,
      expectedVersion: 1, mutationKey: "track-select-foreign",
    }, editorActor), (error: any) => error instanceof TrackWorkspaceError && error.code === "PROJECT_MISMATCH");
    const unchanged = await getTrackSelection(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId });
    assert.equal(unchanged.videoId, f.goodId);
    assert.equal(unchanged.version, 1);

    await f.db("o_storyboard").insert({ id: 8101, projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId, prompt: "locked", duration: 2, state: "已完成" });
    await f.db("ext_entity_state").insert({ entityType: "storyboard", entityId: 8101, projectId: f.projectId, version: 0, reviewState: "draft", locked: 1, lockedBy: editorActor.id })
      .onConflict(["entityType", "entityId"]).merge({ locked: 1, lockedBy: editorActor.id });
    await assert.rejects(selectTrackVideo(f.db, {
      projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId, videoId: f.goodId,
      expectedVersion: 1, idempotencyKey: "track-select-locked",
    }, editorActor), (error: any) => error instanceof TrackWorkspaceError && error.code === "LOCKED");
    assert.equal((await f.db("o_videoTrack").where({ id: f.trackId }).first()).videoId, f.goodId);
  } finally {
    await f.destroy();
  }
});

test("candidate deletion is atomic, rejects active jobs, clears a selected pointer, and replays after deletion", options, async () => {
  const f = await fixture();
  const provider: VideoTaskProvider = { fingerprint: "test-provider", submit: async () => ({ taskId: "unused" }), query: async () => ({ status: "pending" }) };
  const jobs = new VideoJobService(f.db, { providerFor: async () => provider, download: async () => undefined, schedule: false, workerId: "track-test-worker" });
  try {
    await selectTrackVideo(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId, videoId: f.goodId, expectedVersion: 0, idempotencyKey: "track-select-delete" }, editorActor);
    const good = await f.db("o_video").where({ id: f.goodId }).first();
    const payload: VideoJobPayload = { modelKey: "model", providerFingerprint: "test-provider", projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId, videoId: f.goodId, outputPath: good.filePath, config: {} };
    await jobs.reserve("active-delete-job", payload);
    await assert.rejects(deleteTrackVideo(f.db, {
      id: f.goodId, projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId,
      expectedVersion: 1, idempotencyKey: "track-delete-active",
    }, editorActor), (error: any) => error instanceof TrackWorkspaceError && error.code === "ACTIVE_JOB");
    assert.equal((await f.db("o_videoTrack").where({ id: f.trackId }).first()).videoId, f.goodId, "failed deletion must not clear the selected pointer");

    await f.db("ext_video_jobs").where({ videoId: f.goodId }).update({ status: "FAILED", lastError: "done" });
    const deleted = await deleteTrackVideo(f.db, {
      videoId: f.goodId, projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId,
      expectedVersion: 1, mutationKey: "track-delete-success",
    }, editorActor);
    assert.equal(deleted.wasSelected, true);
    assert.equal(deleted.track.videoId, null);
    assert.equal(deleted.track.version, 2);
    assert.equal(await f.db("o_video").where({ id: f.goodId }).first(), undefined);
    const replay = await deleteTrackVideo(f.db, {
      id: f.goodId, projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId,
      expectedVersion: 1, idempotencyKey: "track-delete-success",
    }, editorActor);
    assert.equal(replay.reused, true);
    assert.equal(replay.videoId, f.goodId);
  } finally {
    jobs.stop();
    await f.destroy();
  }
});

test("track creation is project scoped and reuses the same database id for one idempotency key", options, async () => {
  const f = await fixture();
  try {
    const first = await createTrack(f.db, {
      projectId: f.projectId,
      scriptId: f.scriptId,
      duration: 8,
      idempotencyKey: "track-create-stable",
    }, editorActor);
    const replay = await createTrack(f.db, {
      projectId: f.projectId,
      scriptId: f.scriptId,
      duration: 8,
      idempotencyKey: "track-create-stable",
    }, editorActor);
    assert.equal(replay.reused, true);
    assert.equal(replay.track.id, first.track.id);
    assert.equal(replay.track.version, 0);
    assert.equal(await f.db("o_videoTrack").where({ id: first.track.id }).count("id as count").first().then((row) => Number(row?.count)), 1);

    await assert.rejects(createTrack(f.db, {
      projectId: f.projectId,
      scriptId: f.scriptId,
      duration: 9,
      idempotencyKey: "track-create-stable",
    }, editorActor), (error: any) => error instanceof TrackWorkspaceError && error.code === "IDEMPOTENCY_CONFLICT");
    await assert.rejects(createTrack(f.db, {
      projectId: f.projectId,
      scriptId: 999_999,
      duration: 8,
      idempotencyKey: "track-create-foreign",
    }, editorActor), (error: any) => error instanceof TrackWorkspaceError && error.code === "PROJECT_MISMATCH");
  } finally {
    await f.destroy();
  }
});

test("track prompt and duration updates use CAS and idempotent receipts", options, async () => {
  const f = await fixture();
  try {
    const promptResult = await updateTrackPrompt(f.db, {
      id: f.trackId,
      projectId: f.projectId,
      scriptId: f.scriptId,
      prompt: "keep this edit",
      expectedVersion: 0,
      idempotencyKey: "track-prompt-update",
    }, editorActor);
    assert.equal(promptResult.track.prompt, "keep this edit");
    assert.equal(promptResult.track.version, 1);

    const replay = await updateTrackPrompt(f.db, {
      id: f.trackId,
      projectId: f.projectId,
      scriptId: f.scriptId,
      prompt: "keep this edit",
      expectedVersion: 0,
      idempotencyKey: "track-prompt-update",
    }, editorActor);
    assert.equal(replay.reused, true);
    assert.equal(replay.track.version, 1);

    await assert.rejects(updateTrackPrompt(f.db, {
      id: f.trackId,
      projectId: f.projectId,
      scriptId: f.scriptId,
      prompt: "stale replacement",
      expectedVersion: 0,
      idempotencyKey: "track-prompt-stale",
    }, editorActor), (error: any) => error instanceof TrackWorkspaceError && error.code === "VERSION_CONFLICT");
    assert.equal((await f.db("o_videoTrack").where({ id: f.trackId }).first()).prompt, "keep this edit");

    const durationResult = await updateTrackDuration(f.db, {
      id: f.trackId,
      projectId: f.projectId,
      scriptId: f.scriptId,
      duration: 12,
      expectedVersion: 1,
      idempotencyKey: "track-duration-update",
    }, editorActor);
    assert.equal(durationResult.track.duration, 12);
    assert.equal(durationResult.track.version, 2);
  } finally {
    await f.destroy();
  }
});

test("track deletion refuses storyboard references and uncertain jobs, then atomically removes terminal history", options, async () => {
  const f = await fixture();
  const provider: VideoTaskProvider = { fingerprint: "test-provider", submit: async () => ({ taskId: "unused" }), query: async () => ({ status: "pending" }) };
  const jobs = new VideoJobService(f.db, { providerFor: async () => provider, download: async () => undefined, schedule: false, workerId: "track-delete-worker" });
  try {
    await f.db("o_videoTrack").where({ id: f.trackId }).update({ videoId: f.goodId });
    await f.db("o_storyboard").insert({ id: 8201, projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId, prompt: "linked", duration: 2, state: "已完成" });
    await assert.rejects(deleteTrack(f.db, {
      id: f.trackId, projectId: f.projectId, scriptId: f.scriptId,
      expectedVersion: 0, idempotencyKey: "track-delete-linked",
    }, editorActor), (error: any) => error instanceof TrackWorkspaceError && error.code === "INVALID_INPUT");
    assert.equal((await f.db("o_videoTrack").where({ id: f.trackId }).first()).videoId, f.goodId);
    assert.equal(await f.db("o_video").where({ videoTrackId: f.trackId }).count("id as count").first().then((row) => Number(row?.count)), 2);
    assert.equal((await f.db("o_storyboard").where({ id: 8201 }).first()).trackId, f.trackId);
    await f.db("o_storyboard").where({ id: 8201 }).update({ trackId: null });

    const good = await f.db("o_video").where({ id: f.goodId }).first();
    const payload: VideoJobPayload = { modelKey: "model", providerFingerprint: "test-provider", projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId, videoId: f.goodId, outputPath: good.filePath, config: {} };
    await jobs.reserve("track-delete-uncertain", payload);
    await f.db("ext_video_jobs").where({ videoId: f.goodId }).update({ status: "RECONCILIATION_REQUIRED" });
    await assert.rejects(deleteTrack(f.db, {
      id: f.trackId, projectId: f.projectId, scriptId: f.scriptId,
      expectedVersion: 0, idempotencyKey: "track-delete-uncertain-job",
    }, editorActor), (error: any) => error instanceof TrackWorkspaceError && error.code === "ACTIVE_JOB");
    assert.equal((await f.db("o_videoTrack").where({ id: f.trackId }).first()).videoId, f.goodId);
    assert.equal(await f.db("o_video").where({ videoTrackId: f.trackId }).count("id as count").first().then((row) => Number(row?.count)), 2);

    await f.db("ext_video_jobs").where({ videoId: f.goodId }).update({ status: "FAILED" });
    await updateTrackPrompt(f.db, {
      id: f.trackId, projectId: f.projectId, scriptId: f.scriptId, prompt: "newer",
      expectedVersion: 0, idempotencyKey: "track-delete-cas-setup",
    }, editorActor);
    await assert.rejects(deleteTrack(f.db, {
      id: f.trackId, projectId: f.projectId, scriptId: f.scriptId,
      expectedVersion: 0, idempotencyKey: "track-delete-stale",
    }, editorActor), (error: any) => error instanceof TrackWorkspaceError && error.code === "VERSION_CONFLICT");
    assert.equal((await f.db("o_videoTrack").where({ id: f.trackId }).first()).videoId, f.goodId);
    assert.equal(await f.db("o_video").where({ videoTrackId: f.trackId }).count("id as count").first().then((row) => Number(row?.count)), 2);

    const deleted = await deleteTrack(f.db, {
      id: f.trackId, projectId: f.projectId, scriptId: f.scriptId,
      expectedVersion: 1, idempotencyKey: "track-delete-terminal",
    }, editorActor);
    assert.equal(deleted.deletedVideoCount, 2);
    assert.equal(await f.db("o_videoTrack").where({ id: f.trackId }).first(), undefined);
    assert.equal(await f.db("o_video").where({ projectId: f.projectId, scriptId: f.scriptId, videoTrackId: f.trackId }).first(), undefined);
    assert.equal(await f.db("ext_video_jobs").where({ projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId }).first(), undefined);
    assert.equal((await f.db("o_video").where({ id: f.foreignId }).first()).id, f.foreignId, "foreign history must remain untouched");

    const replay = await deleteTrack(f.db, {
      id: f.trackId, projectId: f.projectId, scriptId: f.scriptId,
      expectedVersion: 1, idempotencyKey: "track-delete-terminal",
    }, editorActor);
    assert.equal(replay.reused, true);
    assert.equal(replay.id, f.trackId);
  } finally {
    jobs.stop();
    await f.destroy();
  }
});
