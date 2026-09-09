import assert from "node:assert/strict";
import test from "node:test";
import knex, { type Knex } from "knex";
import { ensureProductionStateSchema, ProductionStateError, ProductionStateService, type TrustedActor } from "../src/services/productionState";

const url = process.env.TOONFLOW_TEST_DATABASE_URL;
const human: TrustedActor = { id: "human:1", kind: "human" };
interface Fixture { db: Knex; schema: string; close(): Promise<void>; }

async function fixture(): Promise<Fixture> {
  if (!url) throw new Error("TOONFLOW_TEST_DATABASE_URL is required");
  const schema = `state_${Math.random().toString(36).slice(2)}`;
  const admin = knex({ client: "pg", connection: url });
  await admin.raw(`CREATE SCHEMA "${schema}"`);
  const db = knex({ client: "pg", connection: url, searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.schema.createTable("o_script", (table) => { table.bigInteger("id").primary(); table.bigInteger("projectId").notNullable(); table.text("content"); });
  await db.schema.createTable("o_storyboard", (table) => { table.bigInteger("id").primary(); table.bigInteger("scriptId").notNullable(); table.bigInteger("projectId"); table.text("prompt"); table.text("videoDesc"); table.text("state"); table.integer("index"); });
  await db.schema.createTable("o_assets2Storyboard", (table) => { table.bigInteger("storyboardId").notNullable(); table.bigInteger("assetId").notNullable(); table.primary(["storyboardId", "assetId"]); });
  await db.schema.createTable("o_assets", (table) => { table.bigInteger("id").primary(); table.bigInteger("imageId"); table.bigInteger("projectId"); });
  await db.schema.createTable("o_image", (table) => { table.bigInteger("id").primary(); table.text("state"); });
  await ensureProductionStateSchema(db);
  await db("o_script").insert({ id: 10, projectId: 1, content: "test" });
  await db("o_storyboard").insert({ id: 100, scriptId: 10, projectId: 1, prompt: "before", videoDesc: "before", state: "未生成" });
  return { db, schema, close: async () => { await db.destroy(); await admin.raw(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); } };
}

test("PostgreSQL CAS, raw lock triggers, and rollback are durable", { skip: !url }, async () => {
  const f = await fixture();
  try {
    const second = knex({ client: "pg", connection: url!, searchPath: [f.schema], pool: { min: 0, max: 2 } });
    const firstService = new ProductionStateService(f.db, { now: () => 100 });
    const secondService = new ProductionStateService(second, { now: () => 101 });
    const results = await Promise.allSettled([
      firstService.updateStoryboardContent({ projectId: 1, storyboardId: 100, expectedVersion: 0, actor: human, patch: { prompt: "first" } }),
      secondService.updateStoryboardContent({ projectId: 1, storyboardId: 100, expectedVersion: 0, actor: { id: "human:2", kind: "human" }, patch: { prompt: "second" } }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const state = await firstService.getStoryboardState(1, 100);
    assert.equal(state.state.version, 1);
    await firstService.acquireLock({ projectId: 1, storyboardId: 100, expectedVersion: 1, actor: human });
    await assert.rejects(f.db("o_storyboard").where({ id: 100 }).update({ prompt: "raw" }));
    await assert.rejects(f.db("o_assets2Storyboard").insert({ storyboardId: 100, assetId: 999 }));
    await second.destroy();
  } finally { await f.close(); }
});

test("PostgreSQL raw updates advance version and return approved work to draft", { skip: !url }, async () => {
  const f = await fixture();
  try {
    const service = new ProductionStateService(f.db, { now: () => 200 });
    await service.setReviewState({ projectId: 1, storyboardId: 100, expectedVersion: 0, actor: human, reviewState: "approved" });
    await f.db("o_storyboard").where({ id: 100 }).update({ prompt: "legacy" });
    const state = await service.getStoryboardState(1, 100);
    assert.equal(state.state.version, 2);
    assert.equal(state.state.reviewState, "draft");
  } finally { await f.close(); }
});

test("PostgreSQL transaction rolls back the state reservation when legacy write fails", { skip: !url }, async () => {
  const f = await fixture();
  try {
    await f.db.raw(`
      CREATE FUNCTION test_storyboard_abort() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.prompt = 'explode' THEN RAISE EXCEPTION 'forced legacy error'; END IF; RETURN NEW; END;
      $$;
      CREATE TRIGGER test_storyboard_abort BEFORE UPDATE ON "o_storyboard" FOR EACH ROW EXECUTE FUNCTION test_storyboard_abort();
    `);
    const service = new ProductionStateService(f.db, { now: () => 300 });
    await assert.rejects(service.updateStoryboardContent({ projectId: 1, storyboardId: 100, expectedVersion: 0, actor: human, patch: { prompt: "explode" } }));
    assert.equal((await f.db("o_storyboard").where({ id: 100 }).first()).prompt, "before");
    assert.equal(await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: 100 }).first(), undefined);
  } finally { await f.close(); }
});

test("PostgreSQL production-state migration is repeatable and preserves an active lock", { skip: !url }, async () => {
  const f = await fixture();
  try {
    const service = new ProductionStateService(f.db, { now: () => 400 });
    await service.acquireLock({ projectId: 1, storyboardId: 100, expectedVersion: 0, actor: human });
    await ensureProductionStateSchema(f.db);
    await ensureProductionStateSchema(f.db);
    await assert.rejects(f.db("o_storyboard").where({ id: 100 }).update({ prompt: "must remain locked" }));
    const state = await service.getStoryboardState(1, 100);
    assert.equal(state.state.locked, true);
    assert.equal(state.state.version, 1);
  } finally { await f.close(); }
});
