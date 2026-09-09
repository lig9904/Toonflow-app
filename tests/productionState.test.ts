import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import knex, { type Knex } from "knex";
import {
  ensureProductionStateSchema,
  ProductionStateError,
  ProductionStateService,
  type TrustedActor,
} from "../src/services/productionState";

const human: TrustedActor = { id: "user-7", kind: "human" };
const otherHuman: TrustedActor = { id: "user-8", kind: "human" };
const agent: TrustedActor = { id: "agent-1", kind: "agent" };

interface Fixture {
  db: Knex;
  dbPath: string;
  directory: string;
  service: ProductionStateService;
  close: () => Promise<void>;
}

async function fixture(options: { assetLinks?: Array<{ storyboardId: number; assetId: number }> } = {}): Promise<Fixture> {
  const directory = mkdtempSync(path.join(tmpdir(), "toonflow-production-state-"));
  const dbPath = path.join(directory, "state.sqlite");
  const db = knex({ client: "better-sqlite3", connection: { filename: dbPath }, useNullAsDefault: true });
  await db.schema.createTable("o_script", (table) => {
    table.integer("id").primary();
    table.integer("projectId").notNullable();
  });
  await db.schema.createTable("o_storyboard", (table) => {
    table.integer("id").primary();
    table.integer("scriptId").notNullable();
    table.text("prompt");
    table.text("videoDesc");
    table.text("state");
    table.text("filePath");
    table.text("duration");
    table.integer("trackId");
    table.text("reason");
    table.text("track");
    table.integer("shouldGenerateImage");
    table.integer("projectId");
    table.integer("flowId");
    table.integer("index");
    table.integer("createTime");
  });
  await db.schema.createTable("o_assets2Storyboard", (table) => {
    table.integer("storyboardId").notNullable();
    table.integer("assetId").notNullable();
    table.primary(["storyboardId", "assetId"]);
  });
  await db.schema.createTable("o_image", (table) => {
    table.integer("id").primary();
    table.text("state");
  });
  await db.schema.createTable("o_assets", (table) => {
    table.integer("id").primary();
    table.integer("imageId");
    table.integer("projectId");
  });
  await db("o_script").insert([{ id: 11, projectId: 101 }, { id: 12, projectId: 202 }]);
  await db("o_storyboard").insert([
    { id: 1, scriptId: 11, prompt: "first", videoDesc: "first desc", state: "未生成" },
    { id: 2, scriptId: 12, prompt: "other project", videoDesc: "other desc", state: "未生成" },
    { id: 3, scriptId: 11, prompt: "generating", videoDesc: "", state: "生成中" },
  ]);
  if (options.assetLinks?.length) await db("o_assets2Storyboard").insert(options.assetLinks);
  await ensureProductionStateSchema(db);
  return {
    db,
    dbPath,
    directory,
    service: new ProductionStateService(db, { now: () => 1_700_000_000_000 }),
    close: async () => {
      await db.destroy();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function expectCode(operation: () => Promise<unknown>, code: ProductionStateError["code"]): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof ProductionStateError && error.code === code);
}

async function testReadDoesNotPersistOrIncrement(): Promise<void> {
  const f = await fixture();
  try {
    const result = await f.service.getStoryboardState(101, 1);
    assert.equal(result.state.version, 0);
    assert.equal(await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: 1 }).first(), undefined);
  } finally {
    await f.close();
  }
}

async function testContentPersistsAcrossARealSqliteReopen(): Promise<void> {
  const f = await fixture();
  try {
    const result = await f.service.updateStoryboardContent({
      projectId: 101,
      storyboardId: 1,
      expectedVersion: 0,
      actor: human,
      patch: { prompt: "persisted" },
    });
    assert.equal(result.storyboard.prompt, "persisted");
    assert.equal(result.state.version, 1);
    assert.equal(result.state.updatedBy, human.id);

    await f.db.destroy();
    const reopened = knex({ client: "better-sqlite3", connection: { filename: f.dbPath }, useNullAsDefault: true });
    try {
      const state = await reopened("ext_entity_state").where({ entityType: "storyboard", entityId: 1 }).first();
      const storyboard = await reopened("o_storyboard").where({ id: 1 }).first();
      assert.equal(state.version, 1);
      assert.equal(storyboard.prompt, "persisted");
    } finally {
      await reopened.destroy();
    }
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
}

async function testTwoIndependentClientsWithTheSameVersionOnlyAllowOne(): Promise<void> {
  const f = await fixture();
  try {
    const clientB = knex({ client: "better-sqlite3", connection: { filename: f.dbPath }, useNullAsDefault: true });
    try {
      const serviceB = new ProductionStateService(clientB, { now: () => 1_700_000_000_001 });
      const attempts = await Promise.allSettled([
        f.service.updateStoryboardContent({ projectId: 101, storyboardId: 1, expectedVersion: 0, actor: human, patch: { prompt: "client-a" } }),
        serviceB.updateStoryboardContent({ projectId: 101, storyboardId: 1, expectedVersion: 0, actor: otherHuman, patch: { prompt: "client-b" } }),
      ]);
      assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
      assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
      const rejected = attempts.find((attempt) => attempt.status === "rejected");
      assert(rejected && rejected.status === "rejected");
      assert(rejected.reason instanceof ProductionStateError);
      assert.equal(rejected.reason.code, "VERSION_CONFLICT");
      assert.equal((await f.service.getStoryboardState(101, 1)).state.version, 1);
    } finally {
      await clientB.destroy();
    }
  } finally {
    await f.close();
  }
}

async function testLockRejectsServiceAndRawLegacyWrites(): Promise<void> {
  const f = await fixture();
  try {
    const locked = await f.service.acquireLock({ projectId: 101, storyboardId: 1, expectedVersion: 0, actor: human });
    assert.equal(locked.state.locked, true);
    assert.equal(locked.state.version, 1);
    await expectCode(
      () => f.service.updateStoryboardContent({ projectId: 101, storyboardId: 1, expectedVersion: 1, actor: human, patch: { prompt: "blocked" } }),
      "LOCKED",
    );
    await assert.rejects(f.db("o_storyboard").where({ id: 1 }).update({ prompt: "raw blocked" }));
    await assert.rejects(f.db("o_assets2Storyboard").insert({ storyboardId: 1, assetId: 77 }));
    await assert.rejects(f.db("o_storyboard").where({ id: 1 }).del());
    assert.equal((await f.db("o_storyboard").where({ id: 1 }).first()).prompt, "first");
  } finally {
    await f.close();
  }
}

async function testProjectBindingAndHumanOnlyActions(): Promise<void> {
  const f = await fixture();
  try {
    await expectCode(() => f.service.getStoryboardState(202, 1), "PROJECT_MISMATCH");
    await expectCode(
      () => f.service.acquireLock({ projectId: 101, storyboardId: 1, expectedVersion: 0, actor: agent }),
      "FORBIDDEN",
    );
    await expectCode(
      () => f.service.acquireLock({ projectId: 101, storyboardId: 3, expectedVersion: 0, actor: human }),
      "LOCKED",
    );
  } finally {
    await f.close();
  }
}

async function testGeneratingReferencedAssetPreventsLockUntilItCompletes(): Promise<void> {
  const f = await fixture();
  try {
    await f.db("o_image").insert({ id: 501, state: "生成中" });
    await f.db("o_assets").insert({ id: 401, imageId: 501, projectId: 101 });
    await f.db("o_assets2Storyboard").insert({ storyboardId: 1, assetId: 401 });
    await expectCode(
      () => f.service.acquireLock({ projectId: 101, storyboardId: 1, expectedVersion: 1, actor: human }),
      "LOCKED",
    );
    await f.db("o_image").where({ id: 501 }).update({ state: "已完成" });
    const locked = await f.service.acquireLock({ projectId: 101, storyboardId: 1, expectedVersion: 1, actor: human });
    assert.equal(locked.state.locked, true);
  } finally {
    await f.close();
  }
}

async function testReviewTransitionsIncrementAndApprovedContentReturnsToDraft(): Promise<void> {
  const f = await fixture();
  try {
    const approved = await f.service.setReviewState({
      projectId: 101,
      storyboardId: 1,
      expectedVersion: 0,
      actor: human,
      reviewState: "approved",
    });
    assert.equal(approved.state.version, 1);
    assert.equal(approved.state.reviewState, "approved");
    const edited = await f.service.updateStoryboardContent({
      projectId: 101,
      storyboardId: 1,
      expectedVersion: 1,
      actor: human,
      patch: { videoDesc: "requires a fresh review" },
    });
    assert.equal(edited.state.version, 2);
    assert.equal(edited.state.reviewState, "draft");
  } finally {
    await f.close();
  }
}

async function testRollbackWhenLegacyWriteFailsAfterTheCasReservation(): Promise<void> {
  const f = await fixture();
  try {
    await f.db.raw(`
      CREATE TRIGGER test_storyboard_abort
      BEFORE UPDATE ON o_storyboard
      WHEN NEW.prompt = 'explode'
      BEGIN SELECT RAISE(ABORT, 'forced legacy failure'); END;
    `);
    await assert.rejects(
      f.service.updateStoryboardContent({ projectId: 101, storyboardId: 1, expectedVersion: 0, actor: human, patch: { prompt: "explode" } }),
    );
    assert.equal((await f.db("o_storyboard").where({ id: 1 }).first()).prompt, "first");
    assert.equal(await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: 1 }).first(), undefined);
  } finally {
    await f.close();
  }
}

async function testLegacyWritesAdvanceVersionAndInvalidateStaleExpectedVersion(): Promise<void> {
  const f = await fixture();
  try {
    // A legacy route can be the first writer; it must create version 1 rather
    // than leaving readers with a misleading default version 0.
    await f.db("o_storyboard").where({ id: 3 }).update({ videoDesc: "legacy first write" });
    assert.equal((await f.service.getStoryboardState(101, 3)).state.version, 1);

    await f.service.updateStoryboardContent({ projectId: 101, storyboardId: 1, expectedVersion: 0, actor: human, patch: { prompt: "service" } });
    await f.db("o_storyboard").where({ id: 1 }).update({ prompt: "legacy" });
    const afterLegacy = await f.service.getStoryboardState(101, 1);
    assert.equal(afterLegacy.state.version, 2);
    assert.equal(afterLegacy.state.updatedBy, null);
    await expectCode(
      () => f.service.updateStoryboardContent({ projectId: 101, storyboardId: 1, expectedVersion: 1, actor: human, patch: { videoDesc: "stale" } }),
      "VERSION_CONFLICT",
    );
    await f.db("o_assets2Storyboard").insert({ storyboardId: 1, assetId: 42 });
    assert.equal((await f.service.getStoryboardState(101, 1)).state.version, 3);
  } finally {
    await f.close();
  }
}

async function testFreshAssetChangesCreateStateAndInvalidateVersionZero(): Promise<void> {
  const inserted = await fixture();
  try {
    await inserted.db("o_assets2Storyboard").insert({ storyboardId: 1, assetId: 81 });
    assert.equal((await inserted.service.getStoryboardState(101, 1)).state.version, 1);
    await expectCode(
      () => inserted.service.updateStoryboardContent({ projectId: 101, storyboardId: 1, expectedVersion: 0, actor: human, patch: { prompt: "stale insert" } }),
      "VERSION_CONFLICT",
    );
  } finally {
    await inserted.close();
  }

  const deleted = await fixture({ assetLinks: [{ storyboardId: 1, assetId: 82 }] });
  try {
    await deleted.db("o_assets2Storyboard").where({ storyboardId: 1, assetId: 82 }).del();
    assert.equal((await deleted.service.getStoryboardState(101, 1)).state.version, 1);
    await expectCode(
      () => deleted.service.updateStoryboardContent({ projectId: 101, storyboardId: 1, expectedVersion: 0, actor: human, patch: { prompt: "stale delete" } }),
      "VERSION_CONFLICT",
    );
  } finally {
    await deleted.close();
  }
}

async function testAssetUpdateInvalidatesEachAffectedStoryboardOnce(): Promise<void> {
  const f = await fixture();
  try {
    await f.db("o_assets2Storyboard").insert({ storyboardId: 1, assetId: 91 });
    await f.db("o_assets2Storyboard").where({ storyboardId: 1, assetId: 91 }).update({ assetId: 92 });
    assert.equal((await f.service.getStoryboardState(101, 1)).state.version, 2);

    await f.db("o_assets2Storyboard").insert({ storyboardId: 3, assetId: 93 });
    await f.db("o_assets2Storyboard").where({ storyboardId: 1, assetId: 92 }).update({ storyboardId: 3, assetId: 94 });
    assert.equal((await f.service.getStoryboardState(101, 1)).state.version, 3);
    assert.equal((await f.service.getStoryboardState(101, 3)).state.version, 2);
    await expectCode(
      () => f.service.updateStoryboardContent({ projectId: 101, storyboardId: 1, expectedVersion: 2, actor: human, patch: { prompt: "stale old" } }),
      "VERSION_CONFLICT",
    );
    await expectCode(
      () => f.service.updateStoryboardContent({ projectId: 101, storyboardId: 3, expectedVersion: 1, actor: human, patch: { prompt: "stale new" } }),
      "VERSION_CONFLICT",
    );
  } finally {
    await f.close();
  }
}

async function testRawMutationsReturnApprovedItemsToDraft(): Promise<void> {
  const f = await fixture();
  try {
    await f.service.setReviewState({ projectId: 101, storyboardId: 1, expectedVersion: 0, actor: human, reviewState: "approved" });
    await f.db("o_storyboard").where({ id: 1 }).update({ prompt: "legacy content" });
    let state = (await f.service.getStoryboardState(101, 1)).state;
    assert.equal(state.version, 2);
    assert.equal(state.reviewState, "draft");

    await f.service.setReviewState({ projectId: 101, storyboardId: 1, expectedVersion: 2, actor: human, reviewState: "approved" });
    await f.db("o_assets2Storyboard").insert({ storyboardId: 1, assetId: 95 });
    state = (await f.service.getStoryboardState(101, 1)).state;
    assert.equal(state.version, 4);
    assert.equal(state.reviewState, "draft");
  } finally {
    await f.close();
  }
}

async function testRuntimeEntityValidation(): Promise<void> {
  const f = await fixture();
  try {
    await expectCode(() => f.service.getStoryboardState(0, 1), "INVALID_INPUT");
    await expectCode(() => f.service.getStoryboardState(101, 0), "INVALID_INPUT");
    await expectCode(() => f.service.getStoryboardState(101, "1" as unknown as number), "INVALID_INPUT");
    await expectCode(
      () => f.service.updateStoryboardContent({ projectId: 101, storyboardId: 1, expectedVersion: 0, actor: human, patch: { prompt: 1 as unknown as string } }),
      "INVALID_INPUT",
    );
  } finally {
    await f.close();
  }
}

test("read returns default state without persisting it", testReadDoesNotPersistOrIncrement);
test("content state persists across a real SQLite reopen", testContentPersistsAcrossARealSqliteReopen);
test("two independent SQLite clients with one version have one winner", testTwoIndependentClientsWithTheSameVersionOnlyAllowOne);
test("locks reject service, raw storyboard, relationship, and delete writes", testLockRejectsServiceAndRawLegacyWrites);
test("project binding and human-only mutations are enforced", testProjectBindingAndHumanOnlyActions);
test("a generating referenced asset blocks a storyboard lock until it completes", testGeneratingReferencedAssetPreventsLockUntilItCompletes);
test("review transitions version state and content changes approved to draft", testReviewTransitionsIncrementAndApprovedContentReturnsToDraft);
test("a failed legacy write rolls back its CAS reservation", testRollbackWhenLegacyWriteFailsAfterTheCasReservation);
test("legacy storyboard writes advance versions and reject stale expected versions", testLegacyWritesAdvanceVersionAndInvalidateStaleExpectedVersion);
test("fresh relationship insert and delete create state and invalidate version zero", testFreshAssetChangesCreateStateAndInvalidateVersionZero);
test("relationship update invalidates old and new storyboard exactly once", testAssetUpdateInvalidatesEachAffectedStoryboardOnce);
test("raw storyboard and relationship writes move approved work back to draft", testRawMutationsReturnApprovedItemsToDraft);
test("runtime entity ids and content patch types are validated", testRuntimeEntityValidation);
