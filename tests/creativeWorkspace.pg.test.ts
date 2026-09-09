import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureCreativeWorkspaceSchema, readScriptWorkspace, saveScriptWorkspace, CreativeWorkspaceError } from "../src/services/creativeWorkspace";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const actor = { id: "agent:fixture-run", kind: "agent" as const };
async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureCreativeWorkspaceSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { name: "Workspace", userId: 1 });
  const [otherProjectId] = await insertRowsReturningIds(f.db, "o_project", { name: "Other workspace", userId: 1 });
  const [assetId] = await insertRowsReturningIds(f.db, "o_assets", { projectId, type: "role", name: "Hero" });
  return { ...f, projectId, otherProjectId, assetId };
}

test("script workspace saves server-owned results and replays the exact create operation", options, async () => {
  const f = await fixture();
  try {
    const empty = await readScriptWorkspace(f.db, f.projectId);
    assert.equal(empty.id, null);
    assert.equal((await f.db("o_agentWorkData")).length, 0, "read must not create a cache");
    const input = { projectId: f.projectId, expectedVersion: 0, mutationKey: "create-scripts-once", actor, storySkeleton: "Skeleton", adaptationStrategy: "Strategy", script: [{ name: "Same name", content: "First", assets: [f.assetId] }, { name: "Same name", content: "Second" }] };
    const first = await saveScriptWorkspace(f.db, input);
    assert.equal(first.createdScriptIds.length, 2);
    assert.notEqual(first.createdScriptIds[0], first.createdScriptIds[1], "names are not identities");
    assert.equal(first.script[0].version, 1);
    const replay = await saveScriptWorkspace(f.db, input);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.createdScriptIds, first.createdScriptIds);
    assert.equal((await f.db("o_script").where({ projectId: f.projectId })).length, 2);
    const read = await readScriptWorkspace(f.db, f.projectId);
    assert.equal(read.storySkeleton, "Skeleton");
    assert.equal(read.script[1].content, "Second");
    await assert.rejects(saveScriptWorkspace(f.db, { ...input, storySkeleton: "Changed" }), (e: unknown) => e instanceof CreativeWorkspaceError && e.code === "IDEMPOTENCY_CONFLICT");
  } finally { await f.destroy(); }
});

test("concurrent workspace edits have one winner and preserve the winning business result", options, async () => {
  const f = await fixture();
  try {
    const result = await Promise.allSettled(["A", "B"].map((value) => saveScriptWorkspace(f.db, { projectId: f.projectId, expectedVersion: 0, mutationKey: "concurrent-" + value, actor, storySkeleton: value, script: [{ name: value, content: value }] })));
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
    const current = await readScriptWorkspace(f.db, f.projectId);
    assert.equal(current.script.length, 1);
    assert.equal(current.script[0].content, current.storySkeleton);
    assert.equal(current.version, 1);
  } finally { await f.destroy(); }
});

test("empty assets explicitly clears bindings and omitted assets preserves them", options, async () => {
  const f = await fixture();
  try {
    const created = await saveScriptWorkspace(f.db, { projectId: f.projectId, expectedVersion: 0, mutationKey: "assets-create", actor, script: [{ name: "Episode", content: "Before", assets: [f.assetId] }] });
    const id = created.script[0].id;
    const edit = await saveScriptWorkspace(f.db, { projectId: f.projectId, expectedVersion: 1, mutationKey: "assets-preserve", actor, script: [{ id, expectedVersion: 1, name: "Renamed", content: "After" }] });
    assert.deepEqual(edit.script[0].assets, [f.assetId]);
    const clear = await saveScriptWorkspace(f.db, { projectId: f.projectId, expectedVersion: 2, mutationKey: "assets-clear", actor, script: [{ id, expectedVersion: 2, name: "Renamed", content: "After", assets: [] }] });
    assert.deepEqual(clear.script[0].assets, []);
    assert.equal(clear.script[0].id, id);
  } finally { await f.destroy(); }
});

test("a foreign script or asset rejects the entire mutation without partial cache changes", options, async () => {
  const f = await fixture();
  try {
    const [foreignScript] = await insertRowsReturningIds(f.db, "o_script", { projectId: f.otherProjectId, name: "Foreign", content: "untouched" });
    const [foreignAsset] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.otherProjectId, name: "Other" });
    for (const script of [{ id: foreignScript, expectedVersion: 0, name: "Changed", content: "bad" }, { name: "New", content: "bad", assets: [foreignAsset] }]) {
      await assert.rejects(saveScriptWorkspace(f.db, { projectId: f.projectId, expectedVersion: 0, mutationKey: "reject-foreign", actor, storySkeleton: "must not save", script: [script] }), (e: unknown) => e instanceof CreativeWorkspaceError && e.code === "PROJECT_MISMATCH");
    }
    assert.equal((await readScriptWorkspace(f.db, f.projectId)).version, 0);
    assert.equal((await f.db("o_agentWorkData")).length, 0);
    assert.equal((await f.db("o_script").where({ id: foreignScript }).first()).content, "untouched");
  } finally { await f.destroy(); }
});

test("a stale Agent result cannot overwrite a newer human script edit", options, async () => {
  const f = await fixture();
  try {
    const first = await saveScriptWorkspace(f.db, { projectId: f.projectId, expectedVersion: 0, mutationKey: "initial-create", actor, script: [{ name: "Episode", content: "Draft" }] });
    const id = first.script[0].id;
    await saveScriptWorkspace(f.db, { projectId: f.projectId, expectedVersion: 1, mutationKey: "human-takes-over", actor: { id: "human:1", kind: "human" }, script: [{ id, expectedVersion: 1, name: "Episode", content: "Human version" }] });
    await assert.rejects(saveScriptWorkspace(f.db, { projectId: f.projectId, expectedVersion: 1, mutationKey: "late-agent-result", actor, script: [{ id, expectedVersion: 1, name: "Episode", content: "Late result" }] }), (e: unknown) => e instanceof CreativeWorkspaceError && e.code === "VERSION_CONFLICT");
    assert.equal((await readScriptWorkspace(f.db, f.projectId)).script[0].content, "Human version");
  } finally { await f.destroy(); }
});

test("runtime transaction rollback includes workspace artifacts and mutation receipt", options, async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.db.transaction(async (trx) => {
      await saveScriptWorkspace(trx, { projectId: f.projectId, expectedVersion: 0, mutationKey: "outer-transaction", actor, script: [{ name: "Rollback", content: "Uncommitted" }] });
      throw new Error("event commit failed");
    }));
    assert.equal((await f.db("o_script").where({ projectId: f.projectId })).length, 0);
    assert.equal((await f.db("ext_creative_mutations")).length, 0);
    assert.equal((await readScriptWorkspace(f.db, f.projectId)).version, 0);
  } finally { await f.destroy(); }
});
