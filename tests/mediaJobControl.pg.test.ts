import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { ImageJobService, ensureImageJobsSchema } from "../src/services/imageJobs";
import { VideoJobService, ensureVideoJobsSchema, type VideoTaskProvider } from "../src/services/videoJobs";
import { createImageGenerationService, ensureProductionImageJobSchema } from "../src/services/imageJobs/runtime";
import { ensureProductionStateSchema } from "../src/services/productionState";
import {
  configureMediaJobRecoveryExecutors,
  ensureMediaJobControlSchema,
  mediaJobRecoveryCapability,
  recoverMediaJob,
} from "../src/services/mediaJobControl";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const actor = { id: "human:1" };
const code = (wanted: string) => (error: unknown) => (error as { code?: unknown })?.code === wanted;

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureProductionStateSchema(f.db);
  await ensureImageJobsSchema(f.db);
  await ensureVideoJobsSchema(f.db);
  await ensureMediaJobControlSchema(f.db);
  const [project] = await f.db("o_project").insert({ name: "recover", userId: 1 }).returning("id");
  const [other] = await f.db("o_project").insert({ name: "other", userId: 1 }).returning("id");
  const projectId = Number(project.id), otherProjectId = Number(other.id);
  const [script] = await f.db("o_script").insert({ projectId, name: "episode" }).returning("id");
  const scriptId = Number(script.id);
  const [track] = await f.db("o_videoTrack").insert({ projectId, scriptId, duration: 4 }).returning("id");
  return { ...f, projectId, otherProjectId, scriptId, trackId: Number(track.id) };
}

test("manual image query recovery reuses the accepted task and concurrent duplicate clicks never repeat query or submit", options, async () => {
  const f = await fixture();
  try {
    let submits = 0, queries = 0, downloads = 0;
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const recoveryQuery = new Promise<{ status: "succeeded"; outputUrl: string }>((resolve) => { release = () => resolve({ status: "succeeded", outputUrl: "https://cdn.example/recovered.jpg" }); });
    const provider = {
      fingerprint: "image-provider-v1",
      submit: async () => { submits += 1; return { taskId: "accepted-image-task" }; },
      query: async () => {
        queries += 1;
        if (queries === 1) throw new Error("query outage");
        entered();
        return recoveryQuery;
      },
    };
    let now = 10_000;
    const images = new ImageJobService(f.db, {
      providerFor: async () => provider,
      download: async () => { downloads += 1; },
      maxQueryFailures: 1, schedule: false, now: () => ++now,
    });
    const unusedVideo = { continueKnown: async () => { throw new Error("unexpected video recovery"); } };
    configureMediaJobRecoveryExecutors({ image: images, video: unusedVideo as any });
    const reserved = await images.reserve({ projectId: f.projectId, modelKey: "vendor:image", idempotencyKey: "image-recovery-job", outputPath: "/recover/image.jpg", config: { prompt: "image" } });
    const failed = await images.submitReserved(reserved.job.id);
    assert.equal(failed.status, "RECONCILIATION_REQUIRED");
    assert.equal(submits, 1);
    const capability = await mediaJobRecoveryCapability(f.db, "image", failed.id, f.projectId);
    assert.deepEqual(capability.recoveryActions.map((item) => item.action), ["query"]);

    const input = { projectId: f.projectId, source: "image" as const, jobId: failed.id, expectedUpdatedAt: failed.updatedAt, idempotencyKey: "recover-image-query", action: "query" as const };
    const first = recoverMediaJob(f.db, input, actor);
    await enteredPromise;
    const duplicate = await recoverMediaJob(f.db, input, actor);
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.inProgress, true);
    assert.equal(queries, 2);
    release();
    const completed = await first;
    assert.equal(completed.job.status, "SUCCEEDED");
    const replay = await recoverMediaJob(f.db, input, actor);
    assert.equal(replay.reused, true);
    assert.equal(submits, 1);
    assert.equal(queries, 2);
    assert.equal(downloads, 1);
  } finally { await f.destroy(); }
});

test("manual video download recovery uses the known result URL and does not query or submit again", options, async () => {
  const f = await fixture();
  try {
    let submits = 0, queries = 0, downloads = 0;
    const provider: VideoTaskProvider = {
      fingerprint: "video-provider-v1",
      submit: async () => { submits += 1; return { taskId: "accepted-video-task" }; },
      query: async () => { queries += 1; return { status: "succeeded", outputUrl: "https://cdn.example/recovered.mp4" }; },
    };
    let now = 20_000;
    const videos = new VideoJobService(f.db, {
      providerFor: async () => provider,
      download: async () => { downloads += 1; if (downloads === 1) throw new Error("disk offline"); },
      maxDownloadFailures: 1, schedule: false, now: () => ++now, workerId: "recovery-test-worker",
    });
    configureMediaJobRecoveryExecutors({ image: { continueKnown: async () => { throw new Error("unexpected image recovery"); } } as any, video: videos });
    const reserved = await videos.reserveNewVideo("video-recovery-job", {
      projectId: f.projectId, scriptId: f.scriptId, trackId: f.trackId, modelKey: "vendor:video", providerFingerprint: provider.fingerprint,
      outputPath: "/recover/video.mp4", config: { prompt: "video" }, videoTime: 4,
    });
    const failed = await videos.submitReserved(reserved.job.id);
    assert.equal(failed.status, "RECONCILIATION_REQUIRED");
    assert.equal(submits, 1);
    assert.equal(queries, 1);
    const capability = await mediaJobRecoveryCapability(f.db, "video", failed.id, f.projectId);
    assert.deepEqual(capability.recoveryActions.map((item) => item.action), ["query", "download"]);
    const recovered = await recoverMediaJob(f.db, {
      projectId: f.projectId, source: "video", jobId: failed.id, expectedUpdatedAt: failed.updatedAt,
      idempotencyKey: "recover-video-download", action: "download",
    }, actor);
    assert.equal(recovered.job.status, "SUCCEEDED");
    assert.equal(submits, 1);
    assert.equal(queries, 1);
    assert.equal(downloads, 2);
    const video = await f.db("o_video").where({ id: reserved.job.videoId }).first();
    assert.equal(video.state, "生成成功");
    assert.equal(video.filePath, "/recover/video.mp4");
  } finally { await f.destroy(); }
});

test("unknown IDs, foreign projects, stale versions and missing upstream evidence are rejected before any provider call", options, async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const images = new ImageJobService(f.db, {
      providerFor: async () => ({ fingerprint: "provider", submit: async () => { calls += 1; return { taskId: "never" }; }, query: async () => { calls += 1; return { status: "pending" }; } }),
      download: async () => { calls += 1; }, schedule: false,
    });
    configureMediaJobRecoveryExecutors({ image: images, video: images as any });
    await assert.rejects(recoverMediaJob(f.db, {
      projectId: f.projectId, source: "image", jobId: 999999, expectedUpdatedAt: 0, idempotencyKey: "unknown-recovery", action: "query",
    }, actor), code("NOT_FOUND"));
    const reserved = await images.reserve({ projectId: f.projectId, modelKey: "vendor:image", idempotencyKey: "missing-evidence-job", outputPath: "/missing.jpg", config: { prompt: "x" } });
    await f.db("ext_image_jobs").where({ id: reserved.job.id }).update({ status: "RECONCILIATION_REQUIRED", updatedAt: 50 });
    await assert.rejects(recoverMediaJob(f.db, {
      projectId: f.otherProjectId, source: "image", jobId: reserved.job.id, expectedUpdatedAt: 50, idempotencyKey: "foreign-recovery", action: "query",
    }, actor), code("PROJECT_MISMATCH"));
    await assert.rejects(recoverMediaJob(f.db, {
      projectId: f.projectId, source: "image", jobId: reserved.job.id, expectedUpdatedAt: 49, idempotencyKey: "stale-recovery", action: "query",
    }, actor), code("VERSION_CONFLICT"));
    await assert.rejects(recoverMediaJob(f.db, {
      projectId: f.projectId, source: "image", jobId: reserved.job.id, expectedUpdatedAt: 50, idempotencyKey: "missing-task-recovery", action: "query",
    }, actor), code("NOT_RECOVERABLE"));
    await assert.rejects(recoverMediaJob(f.db, {
      projectId: f.projectId, source: "image", jobId: reserved.job.id, expectedUpdatedAt: 50, idempotencyKey: "missing-url-recovery", action: "download",
    }, actor), code("NOT_RECOVERABLE"));
    assert.equal(calls, 0);
  } finally { await f.destroy(); }
});

test("query recovery explicitly rejects a changed provider fingerprint without calling old-task query or submit", options, async () => {
  const f = await fixture();
  try {
    let submits = 0, queries = 0;
    const original = {
      fingerprint: "provider-v1",
      submit: async () => { submits += 1; return { taskId: "accepted-old-task" }; },
      query: async () => { queries += 1; throw new Error("temporary outage"); },
    };
    let now = 30_000;
    const first = new ImageJobService(f.db, { providerFor: async () => original, download: async () => undefined, maxQueryFailures: 1, schedule: false, now: () => ++now });
    const reserved = await first.reserve({ projectId: f.projectId, modelKey: "vendor:image", idempotencyKey: "fingerprint-recovery-job", outputPath: "/old.jpg", config: { prompt: "old" } });
    const failed = await first.submitReserved(reserved.job.id);
    assert.equal(failed.status, "RECONCILIATION_REQUIRED");
    const changed = new ImageJobService(f.db, {
      providerFor: async () => ({ fingerprint: "provider-v2", submit: async () => { submits += 1; return { taskId: "wrong" }; }, query: async () => { queries += 1; return { status: "pending" }; } }),
      download: async () => undefined, schedule: false, now: () => ++now,
    });
    configureMediaJobRecoveryExecutors({ image: changed, video: changed as any });
    await assert.rejects(recoverMediaJob(f.db, {
      projectId: f.projectId, source: "image", jobId: failed.id, expectedUpdatedAt: failed.updatedAt,
      idempotencyKey: "changed-provider-recovery", action: "query",
    }, actor), code("NOT_RECOVERABLE"));
    assert.equal(submits, 1);
    assert.equal(queries, 1);
    assert.match((await changed.get(failed.id)).lastError ?? "", /供应商.*变化|模型绑定已变化/);
  } finally { await f.destroy(); }
});

test("image recovery keeps a late human selection while saving the recovered output as its existing candidate", options, async () => {
  const f = await fixture();
  try {
    await ensureProductionImageJobSchema(f.db);
    const [asset] = await f.db("o_assets").insert({ projectId: f.projectId, type: "role", name: "hero" }).returning("id");
    let submits = 0;
    let succeeded = false;
    const runtime = createImageGenerationService({
      db: f.db,
      providerFor: async () => ({
        fingerprint: "bound-provider-v1",
        submit: async () => { submits += 1; return { taskId: "bound-upstream-task" }; },
        query: async () => succeeded ? { status: "succeeded", outputUrl: "https://cdn.example/candidate.jpg" } : { status: "pending" },
      }),
      download: async () => undefined,
      uuid: () => "recovered-candidate",
      pollMs: 10,
    });
    const prepared = await runtime.prepare({
      projectId: f.projectId, generationKey: "bound-image-recovery", modelKey: "vendor:image",
      config: { prompt: "hero", referenceList: [], size: "1K", aspectRatio: "16:9" },
      target: { kind: "asset", id: Number(asset.id) },
    });
    await runtime.submitAndWait({ projectId: f.projectId, jobId: prepared.jobId, maxWaitMs: 0 });
    const binding = await f.db("ext_image_job_bindings").where({ jobId: prepared.jobId }).first();
    const [humanImage] = await f.db("o_image").insert({ assetsId: Number(asset.id), type: "role", filePath: "/human-choice.jpg", state: "已完成" }).returning("id");
    await f.db("o_assets").where({ id: Number(asset.id) }).update({ imageId: Number(humanImage.id) });
    await f.db("ext_image_jobs").where({ id: prepared.jobId }).update({ status: "RECONCILIATION_REQUIRED", nextPollAt: null, lastError: "query stopped", updatedAt: 700 });
    succeeded = true;
    configureMediaJobRecoveryExecutors({ image: runtime, video: runtime as any });
    const recovered = await recoverMediaJob(f.db, {
      projectId: f.projectId, source: "image", jobId: prepared.jobId, expectedUpdatedAt: 700,
      idempotencyKey: "recover-bound-image", action: "query",
    }, actor);
    assert.equal(recovered.job.status, "SUCCEEDED");
    assert.equal(submits, 1);
    assert.equal(Number((await f.db("o_assets").where({ id: Number(asset.id) }).first()).imageId), Number(humanImage.id));
    const savedCandidate = await f.db("o_image").where({ id: Number(binding.candidateImageId) }).first();
    assert.equal(savedCandidate.filePath, `/${f.projectId}/assets/recovered-candidate.jpg`);
    assert.equal(savedCandidate.state, "已完成");
    assert.equal(Boolean((await f.db("ext_image_job_bindings").where({ jobId: prepared.jobId }).first()).selected), false);
  } finally { await f.destroy(); }
});
