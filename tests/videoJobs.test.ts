import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import knex, { type Knex } from "knex";
import { ensureVideoJobsSchema, hashVideoJobRequest, VideoJobError, VideoJobService, type VideoJobPayload, type VideoTaskProvider } from "../src/services/videoJobs";

const fingerprint = "endpoint-and-model-v1";
interface Fixture { db: Knex; dbPath: string; directory: string; clock: { now: number }; provider: VideoTaskProvider & { submits: number; queries: number }; downloads: string[]; service: VideoJobService; }

async function fixture(options: { provider?: Partial<VideoTaskProvider>; maxConcurrent?: number; maxQueryFailures?: number; maxDownloadFailures?: number } = {}): Promise<Fixture> {
  const directory = mkdtempSync(path.join(tmpdir(), "toonflow-video-jobs-"));
  const dbPath = path.join(directory, "jobs.sqlite");
  const db = knex({ client: "better-sqlite3", connection: { filename: dbPath }, useNullAsDefault: true });
  for (const [table, columns] of [["o_script", ["projectId"]], ["o_videoTrack", ["projectId", "scriptId"]], ["o_video", ["projectId", "scriptId", "videoTrackId", "filePath", "state", "errorReason", "time"]]] as const) {
    await db.schema.createTable(table, (builder) => { builder.integer("id").primary(); for (const column of columns) builder.text(column); });
  }
  await db.schema.createTable("o_storyboard", (table) => { table.integer("id").primary(); table.integer("projectId"); table.integer("scriptId"); table.integer("trackId"); });
  await db.schema.createTable("ext_entity_state", (table) => { table.text("entityType"); table.integer("entityId"); table.integer("projectId"); table.boolean("locked").notNullable().defaultTo(false); });
  await db("o_script").insert([{ id: 10, projectId: 1 }, { id: 20, projectId: 2 }]);
  await db("o_videoTrack").insert([{ id: 100, projectId: 1, scriptId: 10 }, { id: 200, projectId: 2, scriptId: 20 }]);
  await db("o_video").insert([{ id: 1000, projectId: 1, scriptId: 10, videoTrackId: 100, filePath: "/1/video/a.mp4", state: "生成中" }, { id: 1001, projectId: 1, scriptId: 10, videoTrackId: 100, filePath: "/1/video/c.mp4", state: "生成中" }, { id: 2000, projectId: 2, scriptId: 20, videoTrackId: 200, filePath: "/2/video/b.mp4", state: "生成中" }]);
  await ensureVideoJobsSchema(db);
  const clock = { now: 1_700_000_000_000 };
  const provider: Fixture["provider"] = {
    fingerprint,
    submits: 0,
    queries: 0,
    submit: async () => ({ taskId: `task-${++provider.submits}` }),
    query: async () => { provider.queries += 1; return { status: "pending" }; },
    ...options.provider,
  };
  const downloads: string[] = [];
  const service = new VideoJobService(db, { providerFor: async () => provider, download: async (url, output) => { downloads.push(`${url}:${output}`); },
    now: () => clock.now, schedule: false, initialPollDelayMs: 1, maxConcurrent: options.maxConcurrent ?? 2,
    maxQueryFailures: options.maxQueryFailures, maxDownloadFailures: options.maxDownloadFailures });
  return { db, dbPath, directory, clock, provider, downloads, service };
}

function payload(videoId = 1000, outputPath = "/1/video/a.mp4"): VideoJobPayload {
  return { modelKey: "volcengine:seedance", providerFingerprint: fingerprint, projectId: 1, scriptId: 10, trackId: 100, videoId, outputPath, config: { prompt: "scene" } };
}
function request(outputPath = "/1/video/new.mp4") {
  const { videoId: _videoId, ...value } = payload(1000, outputPath);
  return value;
}
async function close(f: Fixture) { f.service.stop(); await f.db.destroy(); rmSync(f.directory, { recursive: true, force: true }); }

test("same idempotency key and payload reserves one upstream task", async () => {
  const f = await fixture(); try {
    const p = payload(); const hash = hashVideoJobRequest(p);
    const first = await f.service.reserve("request-0001", p, hash);
    const second = await f.service.reserve("request-0001", p, hash);
    assert.equal(first.created, true); assert.equal(second.created, false); assert.equal(first.job.id, second.job.id);
    await f.service.submitReserved(first.job.id); assert.equal(f.provider.submits, 1);
  } finally { await close(f); }
});

test("same idempotency key with a different payload is a conflict", async () => {
  const f = await fixture(); try {
    const p = payload(); await f.service.reserve("request-0002", p, hashVideoJobRequest(p));
    await assert.rejects(() => f.service.reserve("request-0002", { ...p, config: { prompt: "other" } }, hashVideoJobRequest({ ...p, config: { prompt: "other" } })),
      (error: unknown) => error instanceof VideoJobError && error.code === "CONFLICT");
  } finally { await close(f); }
});

test("cross-project video, track, or script references are rejected", async () => {
  const f = await fixture(); try {
    const p = { ...payload(2000, "/2/video/b.mp4"), trackId: 200 };
    await assert.rejects(() => f.service.reserve("request-0003", p, hashVideoJobRequest(p)),
      (error: unknown) => error instanceof VideoJobError && error.code === "PROJECT_MISMATCH");
  } finally { await close(f); }
});

test("restart only queries persisted upstream task and writes before success", async () => {
  const f = await fixture(); try {
    const p = payload(); const reserved = await f.service.reserve("request-0004", p, hashVideoJobRequest(p));
    await f.service.submitReserved(reserved.job.id);
    assert.equal(f.provider.submits, 1);
    await f.db.destroy();
    f.db = knex({ client: "better-sqlite3", connection: { filename: f.dbPath }, useNullAsDefault: true });
    f.service = new VideoJobService(f.db, { providerFor: async () => f.provider, download: async (url, output) => { f.downloads.push(`${url}:${output}`); },
      now: () => f.clock.now, schedule: false, initialPollDelayMs: 1 });
    f.clock.now += 10;
    f.provider.query = async () => ({ status: "succeeded", outputUrl: "https://example.test/video.mp4" });
    await f.service.resumeDueJobs();
    assert.equal(f.provider.submits, 1); assert.equal(f.downloads.length, 1);
    assert.equal((await f.db("o_video").where({ id: 1000 }).first()).state, "生成成功");
  } finally { await close(f); }
});

test("stranded reservation requires reconciliation and never posts again", async () => {
  const f = await fixture(); try {
    const p = payload(); const reserved = await f.service.reserve("request-0005", p, hashVideoJobRequest(p));
    await f.service.resumeDueJobs();
    assert.equal((await f.service.get(reserved.job.id)).status, "SUBMITTING", "a live creator lease must not be reconciled by startup scanning");
    f.clock.now += 120_001;
    await f.service.resumeDueJobs();
    assert.equal(f.provider.submits, 0);
    assert.equal((await f.service.get(reserved.job.id)).status, "RECONCILIATION_REQUIRED");
    assert.equal((await f.db("o_video").where({ id: 1000 }).first()).state, "需人工核对");
  } finally { await close(f); }
});

test("a changed provider endpoint or model fingerprint requires reconciliation", async () => {
  const f = await fixture(); try {
    const p = payload(); const reserved = await f.service.reserve("request-0005b", p, hashVideoJobRequest(p));
    await f.service.submitReserved(reserved.job.id);
    f.clock.now += 10;
    f.provider.fingerprint = "endpoint-and-model-v2";
    await f.service.resumeDueJobs();
    assert.equal((await f.service.get(reserved.job.id)).status, "RECONCILIATION_REQUIRED");
    assert.equal(f.provider.queries, 1, "the initial submission may poll once, but resume must not query the changed provider");
  } finally { await close(f); }
});

test("download retries never resubmit an upstream video", async () => {
  let downloadAttempts = 0;
  const f = await fixture({ provider: { query: async () => ({ status: "succeeded", outputUrl: "https://example.test/video.mp4" }) } });
  const service = new VideoJobService(f.db, { providerFor: async () => f.provider, download: async () => { if (++downloadAttempts === 1) throw new Error("disk full"); },
    now: () => f.clock.now, schedule: false, initialPollDelayMs: 1 });
  try {
    const p = payload(); const reserved = await service.reserve("request-0006", p, hashVideoJobRequest(p));
    await service.submitReserved(reserved.job.id); f.clock.now += 10; await service.resumeDueJobs();
    assert.equal(f.provider.submits, 1); assert.equal(downloadAttempts, 2); assert.equal((await service.get(reserved.job.id)).status, "SUCCEEDED");
  } finally { service.stop(); await close(f); }
});

test("one service observes its configured upstream submission concurrency limit", async () => {
  let active = 0; let maximum = 0;
  const f = await fixture({ maxConcurrent: 1, provider: { submit: async () => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10)); active -= 1; return { taskId: `task-limit-${maximum}` };
  } } });
  try {
    const first = payload(); const second = payload(1001, "/1/video/c.mp4");
    const a = await f.service.reserve("request-0007a", first, hashVideoJobRequest(first));
    const b = await f.service.reserve("request-0007b", second, hashVideoJobRequest(second));
    await Promise.all([f.service.submitReserved(a.job.id), f.service.submitReserved(b.job.id)]);
    assert.equal(maximum, 1);
  } finally { await close(f); }
});

test("concurrent idempotent new-video reservations create exactly one video row", async () => {
  const f = await fixture(); try {
    const value = request(); const hash = hashVideoJobRequest(value);
    const [a, b] = await Promise.all([f.service.reserveNewVideo("request-0008", value, hash), f.service.reserveNewVideo("request-0008", value, hash)]);
    assert.equal([a.created, b.created].filter(Boolean).length, 1);
    assert.equal(a.job.videoId, b.job.videoId);
    assert.equal((await f.db("o_video").where({ filePath: "/1/video/new.mp4" })).length, 1);
  } finally { await close(f); }
});

test("batch reservation rolls back every video when any request is invalid", async () => {
  const f = await fixture(); try {
    const valid = request("/1/video/batch-a.mp4");
    const invalid = { ...request("/1/video/batch-b.mp4"), trackId: 999 };
    await assert.rejects(() => f.service.reserveNewVideos([
      { idempotencyKey: "request-0009a", request: valid, requestHash: hashVideoJobRequest(valid) },
      { idempotencyKey: "request-0009b", request: invalid, requestHash: hashVideoJobRequest(invalid) },
    ]), (error: unknown) => error instanceof VideoJobError && error.code === "PROJECT_MISMATCH");
    assert.equal((await f.db("o_video").where("filePath", "like", "/1/video/batch-%")).length, 0);
    assert.equal((await f.db("ext_video_jobs")).length, 0);
  } finally { await close(f); }
});

test("restart schedules a persisted future poll instead of leaving it dormant", async () => {
  const f = await fixture(); try {
    const p = payload(); const reserved = await f.service.reserve("request-0010", p, hashVideoJobRequest(p));
    await f.service.submitReserved(reserved.job.id);
    f.service.stop();
    f.provider.query = async () => ({ status: "succeeded", outputUrl: "https://example.test/later.mp4" });
    const restarted = new VideoJobService(f.db, { providerFor: async () => f.provider, download: async (url, output) => { f.downloads.push(`${url}:${output}`); },
      now: () => f.clock.now, initialPollDelayMs: 1, schedule: true });
    await restarted.resumeDueJobs();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await restarted.get(reserved.job.id)).status, "SUCCEEDED");
    restarted.stop();
  } finally { await close(f); }
});

test("exhausted upstream query retries require reconciliation rather than marking generation failed", async () => {
  const f = await fixture({ maxQueryFailures: 1, provider: { query: async () => { throw new Error("temporary upstream outage"); } } });
  try {
    const p = payload(); const reserved = await f.service.reserve("request-0011", p, hashVideoJobRequest(p));
    await f.service.submitReserved(reserved.job.id);
    const job = await f.service.get(reserved.job.id);
    assert.equal(job.status, "RECONCILIATION_REQUIRED");
    assert.equal(job.upstreamTaskId, "task-1");
    assert.equal((await f.db("o_video").where({ id: 1000 }).first()).state, "需人工核对");
  } finally { await close(f); }
});

test("upstream succeeded without a video URL is a retryable protocol fault, never a generation failure", async () => {
  const f = await fixture({ maxQueryFailures: 1, provider: { query: async () => ({ status: "succeeded" }) } });
  try {
    const p = payload(); const reserved = await f.service.reserve("request-0011b", p, hashVideoJobRequest(p));
    await f.service.submitReserved(reserved.job.id);
    const job = await f.service.get(reserved.job.id);
    assert.equal(job.status, "RECONCILIATION_REQUIRED");
    assert.equal(job.upstreamTaskId, "task-1");
    assert.match(job.lastError ?? "", /未返回视频地址/);
  } finally { await close(f); }
});

test("exhausted download retries preserve result URL and require reconciliation", async () => {
  const f = await fixture({ maxDownloadFailures: 1, provider: { query: async () => ({ status: "succeeded", outputUrl: "https://example.test/keep-url.mp4" }) } });
  const service = new VideoJobService(f.db, { providerFor: async () => f.provider, download: async () => { throw new Error("disk unavailable"); },
    now: () => f.clock.now, schedule: false, initialPollDelayMs: 1, maxDownloadFailures: 1 });
  try {
    const p = payload(); const reserved = await service.reserve("request-0012", p, hashVideoJobRequest(p));
    await service.submitReserved(reserved.job.id);
    const job = await service.get(reserved.job.id);
    assert.equal(job.status, "RECONCILIATION_REQUIRED");
    assert.equal(job.resultUrl, "https://example.test/keep-url.mp4");
  } finally { service.stop(); await close(f); }
});

test("stop prevents a pending in-flight query from scheduling another poll", async () => {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture({ provider: { query: async () => { f.provider.queries += 1; started(); await pending; return { status: "pending" }; } } });
  try {
    const p = payload(); const reserved = await f.service.reserve("request-0013", p, hashVideoJobRequest(p));
    const run = f.service.submitReserved(reserved.job.id);
    await entered;
    f.service.stop();
    release();
    await run;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.provider.queries, 1);
    assert.equal((await f.service.get(reserved.job.id)).status, "POLLING");
  } finally { await close(f); }
});

test("invalid concurrency bounds are rejected before work begins", async () => {
  const f = await fixture();
  try {
    assert.throws(() => new VideoJobService(f.db, { providerFor: async () => f.provider, download: async () => {}, maxConcurrent: 0 }),
      (error: unknown) => error instanceof VideoJobError && error.code === "INVALID_INPUT");
  } finally { await close(f); }
});

test("media references are available to first submit then compacted from durable payload without breaking idempotency or restart", async () => {
  const seen: unknown[] = [];
  const f = await fixture({ provider: { submit: async (config) => { seen.push(config); return { taskId: "task-media" }; } } });
  try {
    const media = `data:image/png;base64,VERY_LARGE_MEDIA_REFERENCE_SHOULD_NOT_PERSIST${"x".repeat(200_000)}`;
    const p = { ...payload(), config: { prompt: "scene", referenceList: [{ type: "image", base64: media }] } };
    const hash = hashVideoJobRequest(p);
    const reserved = await f.service.reserve("request-0014", p, hash);
    await f.service.submitReserved(reserved.job.id);
    assert.deepEqual(seen, [p.config]);
    const stored = await f.db("ext_video_jobs").where({ id: reserved.job.id }).first();
    assert.doesNotMatch(stored.payload, /VERY_LARGE_MEDIA_REFERENCE_SHOULD_NOT_PERSIST/);
    assert.match(stored.payload, /contentHash/);
    assert(stored.payload.length < media.length / 10, "durable payload must not retain NAS media bytes");
    const duplicate = await f.service.reserve("request-0014", p, hash);
    assert.equal(duplicate.created, false);
    f.clock.now += 10;
    f.provider.query = async () => ({ status: "succeeded", outputUrl: "https://example.test/compacted.mp4" });
    await f.service.resumeDueJobs();
    assert.equal((await f.service.get(reserved.job.id)).status, "SUCCEEDED");
  } finally { await close(f); }
});

test("startup reconciliation compacts a stranded submitting payload without retrying its media POST", async () => {
  const f = await fixture();
  try {
    const media = `data:video/mp4;base64,STRANDED_MEDIA_REFERENCE_SHOULD_NOT_PERSIST${"x".repeat(200_000)}`;
    const p = { ...payload(), config: { prompt: "scene", referenceList: [{ type: "video", base64: media }] } };
    const reserved = await f.service.reserve("request-0015", p, hashVideoJobRequest(p));
    f.clock.now += 120_001;
    await f.service.resumeDueJobs();
    const stored = await f.db("ext_video_jobs").where({ id: reserved.job.id }).first();
    assert.equal((await f.service.get(reserved.job.id)).status, "RECONCILIATION_REQUIRED");
    assert.doesNotMatch(stored.payload, /STRANDED_MEDIA_REFERENCE_SHOULD_NOT_PERSIST/);
    assert.match(stored.payload, /contentHash/);
    assert(stored.payload.length < media.length / 10, "reconciliation must also release NAS media bytes");
    assert.equal(f.provider.submits, 0);
  } finally { await close(f); }
});
