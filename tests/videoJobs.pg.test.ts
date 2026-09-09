import assert from "node:assert/strict";
import test from "node:test";
import knex, { type Knex } from "knex";
import { ensureVideoJobsSchema, hashVideoJobRequest, VideoJobService, type VideoJobRequest, type VideoTaskProvider } from "../src/services/videoJobs";

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
