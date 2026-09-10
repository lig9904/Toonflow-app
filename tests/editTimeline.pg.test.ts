import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { EditTimelineError, ensureEditTimelineSchema, readEditTimeline, saveEditTimeline } from "../src/services/editTimeline";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const actor = { id: "human:1", kind: "human" as const };

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { name: "Timeline project", userId: 1 });
  const [scriptId] = await insertRowsReturningIds(f.db, "o_script", { projectId, name: "Episode", content: "" });
  return { ...f, projectId, scriptId };
}

test("edit timeline is lazily created, scoped by project/script, and replays idempotently", options, async () => {
  const f = await fixture();
  try {
    const empty = await readEditTimeline(f.db, f.projectId, f.scriptId);
    assert.equal(empty.exists, false);
    assert.equal(empty.version, 0);
    const timeline = { tracks: [{ id: "main", type: "video", clips: [{ id: "shot-1", startTime: 0, endTime: 2 }] }] };
    const first = await saveEditTimeline(f.db, { projectId: f.projectId, scriptId: f.scriptId, expectedVersion: 0, idempotencyKey: "timeline-create-1", timeline }, actor);
    assert.equal(first.version, 1);
    assert.equal(first.replayed, false);
    const replay = await saveEditTimeline(f.db, { projectId: f.projectId, scriptId: f.scriptId, expectedVersion: 0, idempotencyKey: "timeline-create-1", timeline }, actor);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.timeline, timeline);
    await assert.rejects(
      saveEditTimeline(f.db, { projectId: f.projectId, scriptId: f.scriptId, expectedVersion: 0, idempotencyKey: "timeline-create-1", timeline: { tracks: [{ id: "changed", type: "video", clips: [] }] } }, actor),
      (error: any) => error instanceof EditTimelineError && error.code === "IDEMPOTENCY_CONFLICT",
    );
    await assert.rejects(
      saveEditTimeline(f.db, { projectId: f.projectId, scriptId: f.scriptId, expectedVersion: 1, idempotencyKey: "timeline-create-1", timeline }, actor),
      (error: any) => error instanceof EditTimelineError && error.code === "IDEMPOTENCY_CONFLICT",
    );
    assert.equal((await readEditTimeline(f.db, f.projectId, f.scriptId)).version, 1);
  } finally { await f.destroy(); }
});

test("invalid timeline shapes are rejected before any row is written", options, async () => {
  const f = await fixture();
  try {
    for (const timeline of [
      {},
      { tracks: "bad" },
      { tracks: [{ id: "main", type: "video", clips: [{ id: "bad", startTime: 2, endTime: 2 }] }] },
      { tracks: [{ id: "main", type: "video", clips: [{ id: "bad", startTime: 0, endTime: Number.POSITIVE_INFINITY }] }] },
    ]) {
      await assert.rejects(
        saveEditTimeline(f.db, { projectId: f.projectId, scriptId: f.scriptId, expectedVersion: 0, idempotencyKey: "timeline-invalid-" + Math.random().toString(36).slice(2), timeline }, actor),
        (error: any) => error instanceof EditTimelineError && error.code === "INVALID_INPUT",
      );
    }
    assert.equal((await readEditTimeline(f.db, f.projectId, f.scriptId)).exists, false);
  } finally { await f.destroy(); }
});

test("stale edit timeline writes return the current snapshot and preserve the winner", options, async () => {
  const f = await fixture();
  try {
    const firstTimeline = { tracks: [] };
    await saveEditTimeline(f.db, { projectId: f.projectId, scriptId: f.scriptId, expectedVersion: 0, idempotencyKey: "timeline-first-1", timeline: firstTimeline }, actor);
    const winningTimeline = { tracks: [{ id: "main", type: "video", clips: [] }] };
    await saveEditTimeline(f.db, { projectId: f.projectId, scriptId: f.scriptId, expectedVersion: 1, idempotencyKey: "timeline-win-1", timeline: winningTimeline }, actor);
    await assert.rejects(
      saveEditTimeline(f.db, { projectId: f.projectId, scriptId: f.scriptId, expectedVersion: 1, idempotencyKey: "timeline-stale-1", timeline: { tracks: [{ id: "local", type: "video", clips: [] }] } }, { id: "human:2", kind: "human" }),
      (error: any) => error instanceof EditTimelineError && error.code === "VERSION_CONFLICT" && error.current?.version === 2,
    );
    const current = await readEditTimeline(f.db, f.projectId, f.scriptId);
    assert.deepEqual(current.timeline, winningTimeline);
    assert.equal(current.version, 2);
  } finally { await f.destroy(); }
});

test("timeline schema creation is repeatable", options, async () => {
  const f = await fixture();
  try {
    await ensureEditTimelineSchema(f.db);
    await ensureEditTimelineSchema(f.db);
    assert.equal(await f.db.schema.hasTable("ext_edit_timelines"), true);
    assert.equal(await f.db.schema.hasTable("ext_edit_timeline_mutations"), true);
  } finally { await f.destroy(); }
});
