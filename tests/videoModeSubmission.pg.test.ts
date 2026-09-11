import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureCreativeWorkspaceSchema } from "../src/services/creativeWorkspace";
import { ensureProductionStateSchema } from "../src/services/productionState";
import { ensureVideoJobsSchema, hashVideoJobRequest, VideoJobService } from "../src/services/videoJobs";
import { captureVideoModeSelectionSnapshot, claimVideoModeSelectionForSubmission, resolveStoredVideoMode, saveVideoModeIntent, saveVideoReferences } from "../src/services/videoModeResolution";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };

test("a selection edit during slow remote validation is caught by the final project-locked claim before provider POST", options, async () => {
  const fixture = await createPostgresFixture();
  let service: VideoJobService | undefined;
  try {
    await migratePostgresFixture(fixture.db); await ensureCreativeWorkspaceSchema(fixture.db); await ensureProductionStateSchema(fixture.db); await ensureVideoJobsSchema(fixture.db);
    const [projectId] = await insertRowsReturningIds(fixture.db, "o_project", { userId: 1, name: "mode submit race", mode: "text" });
    const [scriptId] = await insertRowsReturningIds(fixture.db, "o_script", { projectId, name: "episode", content: "scene" });
    const [trackId] = await insertRowsReturningIds(fixture.db, "o_videoTrack", { projectId, scriptId, prompt: "human prompt" });
    const [storyboardId] = await insertRowsReturningIds(fixture.db, "o_storyboard", { projectId, scriptId, trackId, index: 0, filePath: "/frame.png", prompt: "frame" });
    const references = [{ id: storyboardId, sources: "storyboard" as const, fileType: "image" as const, purpose: "first_frame" as const }];
    await saveVideoReferences(fixture.db, { projectId, scriptId, trackId, references, expectedRevision: 0, idempotencyKey: "submit-race-refs" }, "human:1");
    await saveVideoModeIntent(fixture.db, { projectId, scriptId, trackId, modeIntent: "singleImage", expectedRevision: 1, idempotencyKey: "submit-race-mode" }, "human:1");
    const resolution = await resolveStoredVideoMode(fixture.db, { projectId, scriptId, trackId, model: "fixture:video", capabilities: { mode: ["text", "singleImage"] }, references, expectedIntentRevision: 2 });
    const readMedia = async (filePath: string) => `data:image/png;base64,${Buffer.from(`bytes:${filePath}`).toString("base64")}`;
    const snapshot = await captureVideoModeSelectionSnapshot(fixture.db, { projectId, scriptId, trackId, resolution }, readMedia);
    let submits = 0, release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
    const provider = { fingerprint: "mode-race-provider", submit: async () => { submits += 1; return { taskId: "must-not-submit" }; }, query: async () => ({ status: "pending" as const }) };
    service = new VideoJobService(fixture.db, { providerFor: async () => provider, download: async () => undefined, schedule: false, beforeSubmit: async (job, config) => {
      entered(); await waiting; const frozen = (config as any).toonflowModeSelection;
      await claimVideoModeSelectionForSubmission(fixture.db, { jobId: job.id, projectId, scriptId, trackId, snapshot: frozen }, readMedia);
    } });
    const request = { modelKey: "fixture:video", providerFingerprint: provider.fingerprint, projectId, scriptId, trackId, outputPath: "/video/race.mp4", config: { prompt: "human prompt", mode: "singleImage", referenceList: [{ type: "image", base64: await readMedia("/frame.png") }], toonflowModeSelection: snapshot } };
    const reserved = await service.reserveNewVideo("mode-submit-race", request, hashVideoJobRequest(request));
    const submitting = service.submitReserved(reserved.job.id); await started;
    await saveVideoModeIntent(fixture.db, { projectId, scriptId, trackId, modeIntent: "auto", expectedRevision: 2, idempotencyKey: "submit-race-new-mode" }, "human:2");
    release(); const result = await submitting;
    assert.equal(submits, 0); assert.equal(result.status, "FAILED"); assert.equal(result.submissionOutcome, "not_submitted"); assert.match(result.lastError ?? "", /已变化/);
  } finally { service?.stop(); await fixture.destroy(); }
});
