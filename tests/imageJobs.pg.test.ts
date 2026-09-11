import assert from "node:assert/strict";
import test from "node:test";
import knex, { type Knex } from "knex";
import { createPostgresFixture } from "../src/lib/postgresTest";
import { ensureImageJobsSchema, hashImageJobRequest, ImageJobError, ImageJobService, type ImageJob, type ImageJobDependencies } from "../src/services/imageJobs";
import type { PersistentImageTaskProvider, PersistentAsyncImageTaskProvider } from "../src/lib/persistentImageAdapter";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };

async function fixture() {
  const f = await createPostgresFixture();
  await ensureImageJobsSchema(f.db);
  return f;
}

function provider(state: { submits?: number; queries?: number; submit?: () => Promise<{ taskId: string }>; query?: (taskId: string) => Promise<{ status: "pending" | "succeeded" | "failed"; outputUrl?: string; error?: string }> } = {}): PersistentAsyncImageTaskProvider {
  return { fingerprint: "image-provider-v1", submit: async () => { state.submits = (state.submits ?? 0) + 1; return state.submit ? state.submit() : { taskId: `image-task-${state.submits}` }; }, query: async (taskId) => { state.queries = (state.queries ?? 0) + 1; return state.query ? state.query(taskId) : { status: "pending" }; } };
}

function request(key: string, projectId = 1) {
  return { projectId, modelKey: "zhenzhen:seedream-v5", idempotencyKey: key, outputPath: `/images/${projectId}/${key}.jpg`, config: { prompt: "a durable image", referenceList: [{ type: "image", base64: "data:image/png;base64,AAAA" }] }, context: { assetId: 10, version: 2 } };
}

function service(db: Knex, p: PersistentImageTaskProvider, extra: Partial<ImageJobDependencies> = {}) {
  return new ImageJobService(db, { providerFor: async () => p, download: async () => undefined, schedule: false, initialPollDelayMs: 0, ...extra });
}

test("image jobs reserve idempotently per project and compact references after receipt", options, async () => {
  const f = await fixture();
  try {
    const p = provider();
    const jobs = service(f.db, p);
    const first = await jobs.reserve(request("image-key-1"));
    const reused = await jobs.reserve(request("image-key-1"));
    assert.equal(reused.reused, true);
    assert.equal(reused.job.id, first.job.id);
    const otherProject = await jobs.reserve(request("image-key-1", 2));
    assert.notEqual(otherProject.job.id, first.job.id);
    await assert.rejects(jobs.reserve({ ...request("image-key-1"), config: { prompt: "different" } }), (error: unknown) => error instanceof ImageJobError && error.code === "CONFLICT");
    await jobs.submitReserved(first.job.id);
    const compacted = await jobs.get(first.job.id);
    const reference = (compacted.payload.config as { referenceList: Array<Record<string, unknown>> }).referenceList[0];
    assert.equal("base64" in reference, false);
    assert.equal(typeof reference.contentHash, "string");
    assert.deepEqual(compacted.payload.context, { assetId: 10, version: 2 });
  } finally { await f.destroy(); }
});

test("legacy async payload bytes and hash remain reusable after sync mode support", options, async () => {
  const f = await fixture();
  try {
    const p = provider();
    const input = request("legacy-payload-1");
    const legacyPayload = { projectId: input.projectId, modelKey: input.modelKey, providerFingerprint: p.fingerprint, outputPath: input.outputPath, config: input.config, context: input.context };
    const payloadHash = hashImageJobRequest(legacyPayload);
    await f.db("ext_image_jobs").insert({ idempotencyKey: input.idempotencyKey, payloadHash, modelKey: input.modelKey, projectId: input.projectId, outputPath: input.outputPath, payload: JSON.stringify(legacyPayload), status: "RESERVED", createdAt: 1, updatedAt: 1 });
    const jobs = service(f.db, p);
    const reused = await jobs.reserve(input);
    assert.equal(reused.reused, true);
    assert.equal(reused.job.payload.executionMode, undefined);
    assert.equal(reused.job.payloadHash, payloadHash);
  } finally { await f.destroy(); }
});

test("concurrent reservations share one row and conflicting payloads reject", options, async () => {
  const f = await fixture();
  try {
    const p = provider();
    const first = service(f.db, p);
    const second = service(knex({ client: "pg", connection: process.env.TOONFLOW_TEST_DATABASE_URL!, searchPath: [f.schema], pool: { min: 0, max: 2 } }), p);
    try {
      const [a, b] = await Promise.all([first.reserve(request("image-concurrent-1")), second.reserve(request("image-concurrent-1"))]);
      assert.equal(a.job.id, b.job.id);
      assert.equal([a.reused, b.reused].filter(Boolean).length, 1);
      await assert.rejects(second.reserve({ ...request("image-concurrent-1"), config: { prompt: "different" } }), (error: unknown) => error instanceof ImageJobError && error.code === "CONFLICT");
    } finally { await (second as any).db?.destroy?.(); }
  } finally { await f.destroy(); }
});

test("recover does not orphan a local SUBMITTING call, but marks an aged startup orphan", options, async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<{ taskId: string }>((resolve) => { release = () => resolve({ taskId: "active-task" }); });
    const p = provider({ submit: async () => { entered(); return blocked; } });
    let now = 100_000;
    const jobs = new ImageJobService(f.db, { providerFor: async () => p, download: async () => undefined, schedule: false, now: () => now, submissionLeaseMs: 1_000 });
    const reserved = await jobs.reserve(request("image-active-submit"));
    const submitting = jobs.submitReserved(reserved.job.id);
    await enteredPromise;
    await jobs.resumeDueJobs();
    assert.equal((await jobs.get(reserved.job.id)).status, "SUBMITTING");
    release();
    await submitting;
    assert.equal((await jobs.get(reserved.job.id)).status, "POLLING");

    const orphan = await jobs.reserve(request("image-orphan-submit"));
    await f.db("ext_image_jobs").where({ id: orphan.job.id }).update({ status: "SUBMITTING", updatedAt: 1 });
    now = 100_000;
    await jobs.resumeDueJobs();
    assert.equal((await jobs.get(orphan.job.id)).status, "RECONCILIATION_REQUIRED");
  } finally { await f.destroy(); }
});

test("submission is one-shot and restart only queries an accepted image task", options, async () => {
  const f = await fixture();
  try {
    let state: "pending" | "succeeded" = "pending";
    const counts = { submits: 0, queries: 0 };
    const p = provider({ submits: 0, queries: 0, submit: async () => { counts.submits += 1; return { taskId: "accepted-image" }; }, query: async () => { counts.queries += 1; return state === "pending" ? { status: "pending" } : { status: "succeeded", outputUrl: "https://cdn.example/image.jpg" }; } });
    const first = service(f.db, p);
    const reserved = await first.reserve({ ...request("image-restart-1"), config: { prompt: "without refs" } });
    await first.submitReserved(reserved.job.id);
    assert.equal((await first.get(reserved.job.id)).status, "POLLING");
    state = "succeeded";
    const secondDb = knex({ client: "pg", connection: process.env.TOONFLOW_TEST_DATABASE_URL!, searchPath: [f.schema], pool: { min: 0, max: 2 } });
    try {
      const downloads: string[] = [];
      const second = service(secondDb, p, { download: async (url, output) => { downloads.push(`${url}:${output}`); } });
      await second.resumeDueJobs();
      assert.equal(counts.submits, 1);
      assert.equal(counts.queries, 2);
      assert.deepEqual(downloads, ["https://cdn.example/image.jpg:/images/1/image-restart-1.jpg"]);
      assert.equal((await second.get(reserved.job.id)).status, "SUCCEEDED");
    } finally { await secondDb.destroy(); }
  } finally { await f.destroy(); }
});

test("unknown create result is reconciliation required and never resubmitted", options, async () => {
  const f = await fixture();
  try {
    let submits = 0;
    const p = provider({ submit: async () => { submits += 1; throw new Error("timeout after acceptance"); } });
    const first = service(f.db, p);
    const reserved = await first.reserve({ ...request("image-unknown-1"), config: { prompt: "unknown" } });
    const result = await first.submitReserved(reserved.job.id);
    assert.equal(result.status, "RECONCILIATION_REQUIRED");
    assert.equal(submits, 1);
    const restarted = service(f.db, p);
    await restarted.resumeDueJobs();
    assert.equal(submits, 1);
    assert.equal((await restarted.get(reserved.job.id)).status, "RECONCILIATION_REQUIRED");
  } finally { await f.destroy(); }
});

test("sync URL image completes once without an upstream task or query", options, async () => {
  const f = await fixture();
  try {
    let submits = 0; let queries = 0; const downloads: string[] = [];
    const p: PersistentImageTaskProvider = { executionMode: "sync", fingerprint: "sync-url", submit: async () => { submits += 1; return { outputUrl: "https://cdn.example/sync.png" }; }, query: async () => { queries += 1; throw new Error("sync provider must not query"); } };
    const jobs = service(f.db, p, { download: async (url, output) => { downloads.push(`${url}:${output}`); } });
    const reserved = await jobs.reserve({ ...request("sync-url-1"), modelKey: "agentsYun:sync" });
    const done = await jobs.submitReserved(reserved.job.id);
    assert.equal(done.executionMode, "sync"); assert.equal(done.status, "SUCCEEDED"); assert.equal(done.upstreamTaskId, null); assert.equal(done.submissionOutcome, "submitted");
    assert.deepEqual(downloads, ["https://cdn.example/sync.png:/images/1/sync-url-1.jpg"]);
    await jobs.submitReserved(reserved.job.id);
    assert.equal(submits, 1); assert.equal(queries, 0);
  } finally { await f.destroy(); }
});

test("sync base64 result is durably downloaded and cleared after binding", options, async () => {
  const f = await fixture();
  try {
    const downloads: string[] = []; let saved = 0;
    const p: PersistentImageTaskProvider = { executionMode: "sync", fingerprint: "sync-base64", submit: async () => ({ outputBase64: "iVBORw0KGgo=", mimeType: "image/png" }), query: async () => { throw new Error("must not query"); } };
    const jobs = service(f.db, p, { download: async (url, output) => { downloads.push(`${url}:${output}`); }, onSaved: async () => { saved += 1; } });
    const reserved = await jobs.reserve({ ...request("sync-base64-1"), modelKey: "agentsYun:sync" });
    const done = await jobs.submitReserved(reserved.job.id);
    assert.equal(done.status, "SUCCEEDED"); assert.equal(done.resultUrl, null); assert.equal(saved, 1); assert.equal(downloads[0], "data:image/png;base64,iVBORw0KGgo=:/images/1/sync-base64-1.jpg");
  } finally { await f.destroy(); }
});

test("sync request uses a 300 second lease and restart never repeats an unknown POST", options, async () => {
  const f = await fixture();
  try {
    let now = 1000; let submits = 0; let release!: () => void;
    const waiting = new Promise<{ outputUrl: string }>((resolve) => { release = () => resolve({ outputUrl: "https://cdn.example/late.png" }); });
    const p: PersistentImageTaskProvider = { executionMode: "sync", fingerprint: "sync-long", submit: async () => { submits += 1; return waiting; }, query: async () => { throw new Error("must not query"); } };
    const first = new ImageJobService(f.db, { providerFor: async () => p, download: async () => undefined, schedule: false, now: () => now });
    const reserved = await first.reserve({ ...request("sync-long-1"), modelKey: "agentsYun:sync" });
    const submitting = first.submitReserved(reserved.job.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondDb = knex({ client: "pg", connection: process.env.TOONFLOW_TEST_DATABASE_URL!, searchPath: [f.schema], pool: { min: 0, max: 2 } });
    const second = new ImageJobService(secondDb, { providerFor: async () => p, download: async () => undefined, schedule: false, now: () => now });
    try {
      await second.resumeDueJobs();
      assert.equal((await second.get(reserved.job.id)).status, "SUBMITTING");
      assert.equal((await second.continueKnown(reserved.job.id)).status, "SUBMITTING");
      assert.equal((await second.submitReserved(reserved.job.id)).status, "SUBMITTING");
      now += 305_001;
      await second.resumeDueJobs();
      assert.equal((await second.get(reserved.job.id)).status, "RECONCILIATION_REQUIRED");
      release(); await submitting;
      assert.equal(submits, 1);
    } finally { second.stop(); await secondDb.destroy(); first.stop(); }
  } finally { await f.destroy(); }
});

test("sync download retry does not submit a second image request", options, async () => {
  const f = await fixture();
  try {
    let submits = 0; let downloads = 0; let now = 1000;
    const p: PersistentImageTaskProvider = { executionMode: "sync", fingerprint: "sync-download", submit: async () => { submits += 1; return { outputUrl: "https://cdn.example/retry.png" }; }, query: async () => { throw new Error("must not query"); } };
    const jobs = service(f.db, p, { now: () => now, download: async () => { downloads += 1; if (downloads === 1) throw new Error("temporary disk error"); } });
    const reserved = await jobs.reserve({ ...request("sync-download-1"), modelKey: "agentsYun:sync" });
    await jobs.submitReserved(reserved.job.id);
    now += 10_000;
    await jobs.resumeDueJobs();
    assert.equal(submits, 1); assert.equal(downloads, 2); assert.equal((await jobs.get(reserved.job.id)).status, "SUCCEEDED");
  } finally { await f.destroy(); }
});

test("query and download retries are separate and eventually complete", options, async () => {
  const f = await fixture();
  try {
    let queryCount = 0;
    let downloadCount = 0;
    const p = provider({ query: async () => { queryCount += 1; if (queryCount === 1) throw new Error("temporary query"); return { status: "succeeded", outputUrl: "https://cdn.example/retry.jpg" }; } });
    const jobs = service(f.db, p, { download: async () => { downloadCount += 1; if (downloadCount === 1) throw new Error("temporary download"); } });
    const reserved = await jobs.reserve({ ...request("image-retry-1"), config: { prompt: "retry" } });
    await jobs.submitReserved(reserved.job.id);
    assert.equal((await jobs.get(reserved.job.id)).status, "POLLING");
    await jobs.resumeDueJobs();
    assert.equal((await jobs.get(reserved.job.id)).status, "DOWNLOADING");
    await jobs.resumeDueJobs();
    assert.equal((await jobs.get(reserved.job.id)).status, "SUCCEEDED");
    assert.equal(queryCount, 2);
    assert.equal(downloadCount, 2);
  } finally { await f.destroy(); }
});

test("onSaved is atomic with job completion and late callback conflicts are recoverable", options, async () => {
  const f = await fixture();
  try {
    await f.db.schema.createTable("image_target", (table) => { table.text("id").primary(); table.text("path").notNullable(); });
    const p = provider({ query: async () => ({ status: "succeeded", outputUrl: "https://cdn.example/atomic.jpg" }) });
    const successful = service(f.db, p, { onSaved: async (job, trx) => { await trx("image_target").insert({ id: "ok", path: job.outputPath }); } });
    const first = await successful.reserve({ ...request("image-atomic-1"), config: { prompt: "atomic" } });
    await successful.submitReserved(first.job.id);
    assert.equal((await successful.get(first.job.id)).status, "SUCCEEDED");
    assert.equal((await f.db("image_target").where({ id: "ok" })).length, 1);

    const late = service(f.db, p, { maxDownloadFailures: 1, onSaved: async (_job, trx) => { await trx("image_target").insert({ id: "late", path: "stale" }); throw Object.assign(new Error("version conflict"), { code: "VERSION_CONFLICT" }); } });
    const second = await late.reserve({ ...request("image-atomic-2"), config: { prompt: "late" } });
    const failed = await late.submitReserved(second.job.id);
    assert.equal(failed.status, "RECONCILIATION_REQUIRED");
    assert.equal((await f.db("image_target").where({ id: "late" })).length, 0);
  } finally { await f.destroy(); }
});

test("download retry does not submit a second upstream image task", options, async () => {
  const f = await fixture();
  try {
    let submits = 0;
    let downloads = 0;
    const p = provider({ submit: async () => { submits += 1; return { taskId: "one-submit" }; }, query: async () => ({ status: "succeeded", outputUrl: "https://cdn.example/retry-no-resubmit.jpg" }) });
    const jobs = service(f.db, p, { download: async () => { downloads += 1; if (downloads === 1) throw new Error("temporary disk error"); } });
    const reserved = await jobs.reserve(request("image-download-no-resubmit"));
    await jobs.submitReserved(reserved.job.id);
    await jobs.resumeDueJobs();
    await jobs.resumeDueJobs();
    assert.equal(submits, 1);
    assert.equal(downloads, 2);
    assert.equal((await jobs.get(reserved.job.id)).status, "SUCCEEDED");
  } finally { await f.destroy(); }
});

test("provider fingerprint changes prevent submit/query of old reservations", options, async () => {
  const f = await fixture();
  try {
    const oldProvider = provider();
    const reserved = await service(f.db, oldProvider).reserve({ ...request("image-fingerprint-1"), config: { prompt: "fingerprint" } });
    const changed = provider(); changed.fingerprint = "image-provider-v2";
    let submits = 0; changed.submit = async () => { submits += 1; return { taskId: "should-not-submit" }; };
    const job = await service(f.db, changed).submitReserved(reserved.job.id);
    assert.equal(job.status, "RECONCILIATION_REQUIRED");
    assert.equal(submits, 0);
  } finally { await f.destroy(); }
});
