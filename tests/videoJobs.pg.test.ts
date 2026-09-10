import assert from "node:assert/strict";
import test from "node:test";
import knex, { type Knex } from "knex";
import { ensureVideoJobsSchema, hashVideoJobRequest, VideoJobError, VideoJobService, type VideoJobRequest, type VideoTaskProvider } from "../src/services/videoJobs";

const url = process.env.TOONFLOW_TEST_DATABASE_URL;
interface Fixture { db: Knex; schema: string; close(): Promise<void>; }
async function fixture(): Promise<Fixture> {
  if (!url) throw new Error("TOONFLOW_TEST_DATABASE_URL is required");
  const schema = `jobs_${Math.random().toString(36).slice(2)}`;
  const admin = knex({ client: "pg", connection: url }); await admin.raw(`CREATE SCHEMA "${schema}"`);
  const db = knex({ client: "pg", connection: url, searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.schema.createTable("o_script", (table) => { table.bigInteger("id").primary(); table.bigInteger("projectId").notNullable(); });
  await db.schema.createTable("o_videoTrack", (table) => { table.bigInteger("id").primary(); table.bigInteger("projectId").notNullable(); table.bigInteger("scriptId").notNullable(); });
  await db.schema.createTable("o_video", (table) => { table.bigIncrements("id").primary(); table.text("filePath"); table.text("state"); table.text("errorReason"); table.bigInteger("time"); table.bigInteger("projectId"); table.bigInteger("scriptId"); table.bigInteger("videoTrackId"); });
  await db.schema.createTable("o_storyboard", (table) => { table.bigInteger("id").primary(); table.bigInteger("projectId"); table.bigInteger("scriptId"); table.bigInteger("trackId"); });
  await db.schema.createTable("ext_entity_state", (table) => { table.text("entityType"); table.bigInteger("entityId"); table.bigInteger("projectId"); table.specificType("locked", "smallint").notNullable().defaultTo(0); });
  await db("o_script").insert({ id: 10, projectId: 1 }); await db("o_videoTrack").insert({ id: 20, projectId: 1, scriptId: 10 });
  await ensureVideoJobsSchema(db);
  return { db, schema, close: async () => { await db.destroy(); await admin.raw(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); } };
}

test("PostgreSQL idempotent reservation and restart query use one upstream task", { skip: !url }, async () => {
  const f = await fixture();
  try {
    let submits = 0; let state: "pending" | "succeeded" = "pending"; const downloads: string[] = [];
    const provider: VideoTaskProvider = { fingerprint: "pg-provider", submit: async () => ({ taskId: `task-${++submits}` }), query: async () => state === "pending" ? { status: "pending" } : { status: "succeeded", outputUrl: "https://mock/video" } };
    let now = 1000;
    const make = (db: Knex) => new VideoJobService(db, { providerFor: async () => provider, download: async (url, output) => { downloads.push(`${url}:${output}`); }, now: () => now, schedule: false, initialPollDelayMs: 1 });
    const first = make(f.db);
    const secondDb = knex({ client: "pg", connection: url!, searchPath: [f.schema], pool: { min: 0, max: 2 } });
    const second = make(secondDb);
    const request: VideoJobRequest = { modelKey: "volcengine:seedance", providerFingerprint: "pg-provider", projectId: 1, scriptId: 10, trackId: 20, outputPath: "/1/video/pg.mp4", config: { prompt: "scene" } };
    const hash = hashVideoJobRequest(request);
    const [a, b] = await Promise.all([first.reserveNewVideo("pg-request-1", request, hash), second.reserveNewVideo("pg-request-1", request, hash)]);
    assert.equal(a.job.id, b.job.id); assert.equal([a.created, b.created].filter(Boolean).length, 1);
    await first.submitReserved(a.job.id); assert.equal(submits, 1);
    now += 10; state = "succeeded";
    await second.resumeDueJobs();
    assert.equal(submits, 1); assert.equal(downloads.length, 1); assert.equal((await second.get(a.job.id)).status, "SUCCEEDED");
    await secondDb.destroy();
  } finally { await f.close(); }
});

test("explicit provider non-submission outcomes fail the job without another POST", { skip: !url }, async () => {
  const f = await fixture();
  try {
    let submits = 0;
    const provider: VideoTaskProvider = {
      fingerprint: "explicit-outcome-provider",
      submit: async () => {
        submits += 1;
        throw Object.assign(new Error("HTTP 429 reference upload"), { submissionOutcome: "not_submitted" });
      },
      query: async () => ({ status: "pending" }),
    };
    const service = new VideoJobService(f.db, { providerFor: async () => provider, download: async () => undefined, schedule: false });
    const request: VideoJobRequest = { modelKey: "model", providerFingerprint: provider.fingerprint, projectId: 1, scriptId: 10, trackId: 20, outputPath: "/1/video/not-submitted.mp4", config: { prompt: "scene" } };
    const reserved = await service.reserveNewVideo("pg-explicit-not-submitted", request);
    const failed = await service.submitReserved(reserved.job.id);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.submissionOutcome, "not_submitted");
    assert.equal((await f.db("o_video").where({ id: failed.videoId }).first()).state, "生成失败");
    await service.submitReserved(reserved.job.id);
    assert.equal(submits, 1);
    service.stop();
  } finally { await f.close(); }
});

test("provider rejection is failed while timeout remains reconciliation", { skip: !url }, async () => {
  const f = await fixture();
  try {
    let submits = 0;
    let mode: "rejected" | "timeout" = "rejected";
    const provider: VideoTaskProvider = {
      fingerprint: "rejected-timeout-provider",
      submit: async () => {
        submits += 1;
        if (mode === "rejected") throw Object.assign(new Error("HTTP 400 invalid_parameter"), { submissionOutcome: "rejected" });
        throw new Error("socket timeout");
      },
      query: async () => ({ status: "pending" }),
    };
    const service = new VideoJobService(f.db, { providerFor: async () => provider, download: async () => undefined, schedule: false });
    const rejectedRequest: VideoJobRequest = { modelKey: "model", providerFingerprint: provider.fingerprint, projectId: 1, scriptId: 10, trackId: 20, outputPath: "/1/video/rejected.mp4", config: { prompt: "scene" } };
    const rejected = await service.reserveNewVideo("pg-explicit-rejected", rejectedRequest);
    const rejectedResult = await service.submitReserved(rejected.job.id);
    assert.equal(rejectedResult.status, "FAILED");
    assert.equal(rejectedResult.submissionOutcome, "rejected");

    mode = "timeout";
    const timeoutRequest = { ...rejectedRequest, outputPath: "/1/video/timeout.mp4" };
    const timeout = await service.reserveNewVideo("pg-unknown-timeout", timeoutRequest);
    const timeoutResult = await service.submitReserved(timeout.job.id);
    assert.equal(timeoutResult.status, "RECONCILIATION_REQUIRED");
    assert.equal(timeoutResult.submissionOutcome, "unknown");
    assert.equal(submits, 2);
    service.stop();
  } finally { await f.close(); }
});

test("PostgreSQL submission lease fences other processes and preserves a late upstream receipt", { skip: !url }, async () => {
  const f = await fixture();
  const secondDb = knex({ client: "pg", connection: url!, searchPath: [f.schema], pool: { min: 0, max: 2 } });
  let release!: (task: { taskId: string }) => void;
  let entered!: () => void;
  const submitted = new Promise<{ taskId: string }>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let submits = 0;
  let now = 10_000;
  const provider: VideoTaskProvider = {
    fingerprint: "lease-provider",
    submit: async () => { submits += 1; entered(); return submitted; },
    query: async () => ({ status: "pending" }),
  };
  const create = (db: Knex, workerId: string) => new VideoJobService(db, {
    providerFor: async () => provider,
    download: async () => undefined,
    now: () => now,
    schedule: false,
    initialPollDelayMs: 1,
    workerId,
    submissionLeaseMs: 1_000,
  });
  const creator = create(f.db, "creator-process");
  const observer = create(secondDb, "observer-process");
  try {
    const request: VideoJobRequest = { modelKey: "model", providerFingerprint: "lease-provider", projectId: 1, scriptId: 10, trackId: 20, outputPath: "/1/video/lease.mp4", config: { prompt: "scene" } };
    const reserved = await creator.reserveNewVideo("pg-lease-request", request);
    await observer.resumeDueJobs();
    assert.equal((await observer.get(reserved.job.id)).status, "SUBMITTING", "a live lease is not treated as a crashed submit");
    await assert.rejects(observer.submitReserved(reserved.job.id), (error: unknown) => error instanceof Error && /创建该保留任务/.test(error.message));
    assert.equal(submits, 0, "a non-creator process cannot submit");

    const inFlight = creator.submitReserved(reserved.job.id);
    await started;
    now += 1_001;
    await observer.resumeDueJobs();
    assert.equal((await observer.get(reserved.job.id)).status, "RECONCILIATION_REQUIRED");
    release({ taskId: "late-task-id" });
    const recovered = await inFlight;
    assert.equal(recovered.upstreamTaskId, "late-task-id");
    assert.equal(recovered.status, "POLLING");
    assert.equal(submits, 1);
    assert.equal((await f.db("o_video").where({ id: recovered.videoId }).first()).state, "生成中");
  } finally {
    creator.stop();
    observer.stop();
    await secondDb.destroy();
    await f.close();
  }
});

test("reserveNewVideos participates in a caller transaction without leaving nested reservations", { skip: !url }, async () => {
  const f = await fixture();
  const provider: VideoTaskProvider = { fingerprint: "tx-provider", submit: async () => ({ taskId: "unused" }), query: async () => ({ status: "pending" }) };
  const service = new VideoJobService(f.db, { providerFor: async () => provider, download: async () => undefined, schedule: false, workerId: "transaction-owner" });
  try {
    const request: VideoJobRequest = { modelKey: "model", providerFingerprint: "tx-provider", projectId: 1, scriptId: 10, trackId: 20, outputPath: "/1/video/transaction.mp4", config: { prompt: "scene" } };
    await assert.rejects(f.db.transaction(async (trx) => {
      const [reserved] = await service.reserveNewVideos([{ idempotencyKey: "pg-transaction-request", request }], trx);
      assert.equal(reserved.created, true);
      assert.ok(await trx("o_video").where({ id: reserved.job.videoId }).first());
      throw new Error("rollback outer commit");
    }), /rollback outer commit/);
    assert.equal(await f.db("o_video").where({ filePath: request.outputPath }).count("id as count").first().then((row) => Number(row?.count)), 0);
    assert.equal(await f.db("ext_video_jobs").where({ idempotencyKey: "pg-transaction-request" }).count("id as count").first().then((row) => Number(row?.count)), 0);
  } finally {
    service.stop();
    await f.close();
  }
});

test("locked tracks reject new reservations, while an accepted idempotent job continues after a later lock", { skip: !url }, async () => {
  const f = await fixture();
  let submits = 0;
  let state: "pending" | "succeeded" = "pending";
  let now = 10_000;
  const downloads: string[] = [];
  const provider: VideoTaskProvider = {
    fingerprint: "lock-provider",
    submit: async () => ({ taskId: `locked-task-${++submits}` }),
    query: async () => state === "pending" ? { status: "pending" } : { status: "succeeded", outputUrl: "https://mock.test/locked.mp4" },
  };
  const service = new VideoJobService(f.db, {
    providerFor: async () => provider,
    download: async (source, output) => { downloads.push(`${source}:${output}`); },
    now: () => now,
    schedule: false,
    initialPollDelayMs: 1,
    workerId: "locked-new-owner",
  });
  const request: VideoJobRequest = {
    modelKey: "model",
    providerFingerprint: provider.fingerprint,
    projectId: 1,
    scriptId: 10,
    trackId: 20,
    outputPath: "/1/video/locked-new.mp4",
    config: { prompt: "scene" },
  };
  try {
    await f.db("o_storyboard").insert({ id: 101, projectId: 1, scriptId: 10, trackId: 20 });
    await f.db("ext_entity_state").insert({ entityType: "storyboard", entityId: 101, projectId: 1, locked: 1 });
    await assert.rejects(service.reserveNewVideo("locked-new-request", request), (error: unknown) =>
      error instanceof VideoJobError && error.code === "CONFLICT" && /\u9501\u5b9a/.test(error.message));
    assert.equal(submits, 0);
    assert.equal(await f.db("o_video").where({ filePath: request.outputPath }).count("id as count").first().then((row) => Number(row?.count)), 0);
    assert.equal(await f.db("ext_video_jobs").count("id as count").first().then((row) => Number(row?.count)), 0);

    await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: 101 }).update({ locked: 0 });
    const accepted = await service.reserveNewVideo("locked-new-request", request);
    assert.equal(accepted.created, true);
    await service.submitReserved(accepted.job.id);
    assert.equal(submits, 1);

    await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: 101 }).update({ locked: 1 });
    const replay = await service.reserveNewVideo("locked-new-request", request);
    assert.equal(replay.created, false);
    assert.equal(replay.job.id, accepted.job.id);
    assert.equal(submits, 1, "replay must not submit or rebuild the accepted job");

    state = "succeeded";
    now += 10;
    await service.resumeDueJobs();
    assert.equal((await service.get(accepted.job.id)).status, "SUCCEEDED");
    assert.equal(submits, 1);
    assert.equal(downloads.length, 1);
    assert.equal((await f.db("o_video").where({ id: accepted.job.videoId }).first()).state, "生成成功", "the accepted candidate remains and completes after locking");
  } finally {
    service.stop();
    await f.close();
  }
});

test("locked tracks reject legacy existing-video reserve but replay an accepted reservation", { skip: !url }, async () => {
  const f = await fixture();
  let submits = 0;
  const provider: VideoTaskProvider = {
    fingerprint: "legacy-lock-provider",
    submit: async () => ({ taskId: `legacy-task-${++submits}` }),
    query: async () => ({ status: "pending" }),
  };
  const service = new VideoJobService(f.db, { providerFor: async () => provider, download: async () => undefined, schedule: false, workerId: "legacy-lock-owner" });
  try {
    const [video] = await f.db("o_video").insert({ filePath: "/1/video/legacy-lock.mp4", state: "生成中", projectId: 1, scriptId: 10, videoTrackId: 20 }).returning("id");
    const payload = { modelKey: "model", providerFingerprint: provider.fingerprint, projectId: 1, scriptId: 10, trackId: 20, videoId: Number(video.id), outputPath: "/1/video/legacy-lock.mp4", config: { prompt: "legacy" } };
    await f.db("o_storyboard").insert({ id: 102, projectId: 1, scriptId: 10, trackId: 20 });
    await f.db("ext_entity_state").insert({ entityType: "storyboard", entityId: 102, projectId: 1, locked: 1 });
    await assert.rejects(service.reserve("legacy-lock-request", payload), (error: unknown) => error instanceof VideoJobError && error.code === "CONFLICT" && /\u9501\u5b9a/.test(error.message));
    assert.equal(submits, 0);
    assert.equal(await f.db("ext_video_jobs").count("id as count").first().then((row) => Number(row?.count)), 0);

    await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: 102 }).update({ locked: 0 });
    const accepted = await service.reserve("legacy-lock-request", payload);
    await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: 102 }).update({ locked: 1 });
    const replay = await service.reserve("legacy-lock-request", payload);
    assert.equal(replay.created, false);
    assert.equal(replay.job.id, accepted.job.id);
    await service.submitReserved(accepted.job.id);
    assert.equal(submits, 1, "an accepted legacy reservation may continue after a later lock");
  } finally {
    service.stop();
    await f.close();
  }
});

test("a batch containing a locked track rolls back every new video and job", { skip: !url }, async () => {
  const f = await fixture();
  let submits = 0;
  const provider: VideoTaskProvider = { fingerprint: "batch-lock-provider", submit: async () => ({ taskId: `batch-${++submits}` }), query: async () => ({ status: "pending" }) };
  const service = new VideoJobService(f.db, { providerFor: async () => provider, download: async () => undefined, schedule: false, workerId: "batch-lock-owner" });
  try {
    await f.db("o_videoTrack").insert({ id: 21, projectId: 1, scriptId: 10 });
    await f.db("o_storyboard").insert({ id: 103, projectId: 1, scriptId: 10, trackId: 21 });
    await f.db("ext_entity_state").insert({ entityType: "storyboard", entityId: 103, projectId: 1, locked: 1 });
    const open: VideoJobRequest = { modelKey: "model", providerFingerprint: provider.fingerprint, projectId: 1, scriptId: 10, trackId: 20, outputPath: "/1/video/batch-open.mp4", config: {} };
    const locked: VideoJobRequest = { ...open, trackId: 21, outputPath: "/1/video/batch-locked.mp4" };
    await assert.rejects(service.reserveNewVideos([
      { idempotencyKey: "batch-open-request", request: open },
      { idempotencyKey: "batch-locked-request", request: locked },
    ]), (error: unknown) => error instanceof VideoJobError && error.code === "CONFLICT" && /\u9501\u5b9a/.test(error.message));
    assert.equal(submits, 0);
    assert.equal(await f.db("o_video").whereIn("filePath", [open.outputPath, locked.outputPath]).count("id as count").first().then((row) => Number(row?.count)), 0);
    assert.equal(await f.db("ext_video_jobs").count("id as count").first().then((row) => Number(row?.count)), 0);
  } finally {
    service.stop();
    await f.close();
  }
});
