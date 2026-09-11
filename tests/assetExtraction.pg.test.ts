import test from "node:test";
import assert from "node:assert/strict";
import type { Knex } from "knex";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import {
  applyAssetExtraction,
  AssetExtractionWorkspaceError,
  ensureAssetExtractionWorkspaceSchema,
  scriptContentHash,
  type AssetExtractionProposal,
} from "../src/services/assetExtractionWorkspace";
import {
  createAssetExtractionHelper,
  type AssetExtractionExecutionContext,
} from "../src/services/builtinAgent/assetExtraction";
import { BuiltinRuntimeError } from "../src/services/builtinAgentRuntime";
import type { StructuredScriptModel } from "../src/services/builtinAgent/scriptExecutor";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const human = { id: "human:1", kind: "human" as const };
const episodeOne = "Hero enters the hall carrying a sword.";
const episodeTwo = "Hero waits.";

function source(id: number, content: string, expectedVersion = 0) {
  return { id, expectedVersion, contentHash: scriptContentHash(content) };
}

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureAssetExtractionWorkspaceSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "P", artStyle: "anime" });
  const [otherProjectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Other" });
  const [scriptId, secondScriptId] = await insertRowsReturningIds(f.db, "o_script", [
    { projectId, name: "Episode 1", content: episodeOne },
    { projectId, name: "Episode 2", content: episodeTwo },
  ]);
  return { ...f, projectId, otherProjectId, scriptId, secondScriptId };
}

function context(db: Knex, projectId: number, runId = "11111111-1111-4111-8111-111111111111") {
  const events: Array<{ type: string; data: unknown }> = [];
  const ctx: AssetExtractionExecutionContext = {
    run: { id: runId, projectId, inputRevision: 0, limits: { maxOutputTokens: 10_000 } } as any,
    signal: new AbortController().signal,
    assertActive: async () => undefined,
    step: async (_key, _input, perform) => perform(),
    commit: async (_key, _input, perform) => db.transaction(perform),
    emit: async (type, data) => {
      events.push({ type, data });
      return { runId, sequence: events.length, type, data, createdAt: Date.now() };
    },
  };
  return { ctx, events };
}

function emptyProposal(overrides: Partial<AssetExtractionProposal> = {}): AssetExtractionProposal {
  return { roles: [], scenes: [], props: [], summary: "", ...overrides };
}

test("structured builtin helper uses universalAi, creates real IDs, reuses by explicit ID, and binds only selected episodes", options, async () => {
  const f = await fixture();
  try {
    const [heroId] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, name: "Hero", type: "role", describe: "existing", prompt: "hero" });
    await f.db("o_scriptAssets").insert({ scriptId: f.secondScriptId, assetId: heroId });
    const calls: any[] = [];
    const model: StructuredScriptModel = {
      async generate(request) {
        calls.push(request);
        return {
          value: request.schema.parse({
            roles: [
              { action: "reuse", assetId: heroId, expectedVersion: 0 },
              { action: "create", key: "villain", name: "Villain", description: "black coat", prompt: "villain, black coat" },
            ],
            scenes: [{ action: "create", key: "hall", name: "Hall", description: "stone hall", prompt: "stone hall" }],
            props: [{ action: "create", key: "sword", name: "Sword", description: "silver sword", prompt: "silver sword" }],
            bindings: [{
              scriptId: f.scriptId,
              assets: [
                { kind: "existing", assetId: heroId },
                { kind: "created", key: "villain" },
                { kind: "created", key: "hall" },
                { kind: "created", key: "sword" },
              ],
            }],
            summary: "assets extracted",
          }),
          outputTokens: 42,
        };
      },
    };
    const helper = createAssetExtractionHelper({ db: f.db, model });
    const run = context(f.db, f.projectId);
    const receipt = await helper(run.ctx, {
      projectId: f.projectId,
      sourceScripts: [{ id: f.scriptId, expectedVersion: 0 }, { id: f.secondScriptId, expectedVersion: 0 }],
      request: "extract episode assets",
      maxOutputTokens: 2000,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].role, "universalAi");
    assert.match(calls[0].system, /不将非人类幼态写成人类儿童/);
    assert.match(calls[0].system, /props.*tool/);
    assert.deepEqual(calls[0].input.existingAssets.map((row: any) => row.id), [heroId]);
    assert.equal(receipt.createdAssetIds.length, 3);
    assert.equal(receipt.workspaceVersion, 1);
    const created = await f.db("o_assets").whereIn("id", receipt.createdAssetIds).orderBy("id");
    assert.deepEqual(created.map((row: any) => row.type).sort(), ["role", "scene", "tool"]);
    assert.ok(created.every((row: any) => Number(row.id) > 0));
    const firstLinks = await f.db("o_scriptAssets").where({ scriptId: f.scriptId }).orderBy("assetId");
    assert.deepEqual(firstLinks.map((row: any) => Number(row.assetId)).sort((a: number, b: number) => a - b), [...receipt.assetIds].sort((a, b) => a - b));
    assert.deepEqual((await f.db("o_scriptAssets").where({ scriptId: f.secondScriptId })).map((row: any) => Number(row.assetId)), [heroId], "omitted binding preserves another selected episode");
    assert.equal(run.events.filter((event) => event.type === "artifact.saved").length, 1);

    const replay = await applyAssetExtraction(f.db, {
      projectId: f.projectId,
      expectedWorkspaceVersion: 1,
      sourceScripts: [source(f.secondScriptId, episodeTwo)],
      proposal: emptyProposal(),
      idempotencyKey: "direct-receipt-1",
      actor: human,
    });
    const replayed = await applyAssetExtraction(f.db, {
      projectId: f.projectId,
      expectedWorkspaceVersion: 1,
      sourceScripts: [source(f.secondScriptId, episodeTwo)],
      proposal: emptyProposal(),
      idempotencyKey: "direct-receipt-1",
      actor: human,
    });
    assert.equal(replay.reused, false);
    assert.equal(replayed.reused, true);
    await assert.rejects(
      applyAssetExtraction(f.db, {
        projectId: f.projectId,
        expectedWorkspaceVersion: 1,
        sourceScripts: [source(f.secondScriptId, episodeTwo)],
        proposal: emptyProposal({ summary: "different request" }),
        idempotencyKey: "direct-receipt-1",
        actor: human,
      }),
      (error: any) => error instanceof AssetExtractionWorkspaceError && error.code === "IDEMPOTENCY_CONFLICT",
    );
    const cleared = await applyAssetExtraction(f.db, {
      projectId: f.projectId,
      expectedWorkspaceVersion: 1,
      sourceScripts: [source(f.secondScriptId, episodeTwo)],
      proposal: emptyProposal({ bindings: [{ scriptId: f.secondScriptId, assets: [] }] }),
      idempotencyKey: "explicit-binding-clear",
      actor: human,
    });
    assert.deepEqual(cleared.bindings, [{ scriptId: f.secondScriptId, assetIds: [], version: 1 }]);
    assert.equal(cleared.workspaceVersion, 2);
    assert.equal(await f.db("o_scriptAssets").where({ scriptId: f.secondScriptId }).count("assetId as count").first().then((row: any) => Number(row?.count)), 0);
  } finally {
    await f.destroy();
  }
});

test("persistence rejects name-based reuse, cross-project, derived, wrong-media, wrong-category, and locked edits", options, async () => {
  const f = await fixture();
  try {
    const [roleId] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, name: "Hero", type: "role", describe: "old" });
    const [audioId] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, name: "Voice", type: "audio" });
    const [childId] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, assetsId: roleId, name: "Hero variant", type: "role" });
    const [foreignId] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.otherProjectId, name: "Foreign", type: "role" });
    const sourceScripts = [source(f.scriptId, episodeOne)];
    const apply = (proposal: AssetExtractionProposal, idempotencyKey: string) => applyAssetExtraction(f.db, { projectId: f.projectId, expectedWorkspaceVersion: 0, sourceScripts, proposal, idempotencyKey, actor: human });

    await assert.rejects(
      apply(emptyProposal({ roles: [{ action: "create", key: "hero-copy", name: "Hero", description: "new", prompt: "new" }] }), "reject-same-name"),
      (error: any) => error instanceof AssetExtractionWorkspaceError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      apply(emptyProposal({ roles: [{ action: "reuse", assetId: foreignId, expectedVersion: 0 }] }), "reject-foreign-id"),
      (error: any) => error instanceof AssetExtractionWorkspaceError && error.code === "PROJECT_MISMATCH",
    );
    for (const [assetId, idempotencyKey] of [[audioId, "reject-audio-id"], [childId, "reject-derived-id"]] as const) {
      await assert.rejects(
        apply(emptyProposal({ roles: [{ action: "reuse", assetId, expectedVersion: 0 }] }), idempotencyKey),
        (error: any) => error instanceof AssetExtractionWorkspaceError && error.code === "TYPE_MISMATCH",
      );
    }
    await assert.rejects(
      apply(emptyProposal({ scenes: [{ action: "reuse", assetId: roleId, expectedVersion: 0 }] }), "reject-wrong-category"),
      (error: any) => error instanceof AssetExtractionWorkspaceError && error.code === "TYPE_MISMATCH",
    );

    const [storyboardId] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "shot" });
    await f.db("o_assets2Storyboard").insert({ storyboardId, assetId: roleId });
    await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: storyboardId }).update({ locked: 1, lockedBy: human.id });
    await assert.rejects(
      apply(emptyProposal({ roles: [{ action: "update", assetId: roleId, expectedVersion: 0, description: "agent edit" }] }), "reject-locked-edit"),
      (error: any) => error instanceof AssetExtractionWorkspaceError && error.code === "LOCKED",
    );
    assert.equal((await f.db("o_assets").where({ id: roleId }).first()).describe, "old");
  } finally {
    await f.destroy();
  }
});

test("omitted fields preserve, explicit empty values clear, locked binding removal fails, and late model output cannot beat human edits", options, async () => {
  const f = await fixture();
  try {
    const [assetId] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, name: "Hero", type: "role", describe: "old description", prompt: "keep prompt" });
    await f.db("o_scriptAssets").insert([{ scriptId: f.scriptId, assetId }, { scriptId: f.secondScriptId, assetId }]);

    const metadata = await applyAssetExtraction(f.db, {
      projectId: f.projectId,
      expectedWorkspaceVersion: 0,
      sourceScripts: [source(f.scriptId, episodeOne)],
      proposal: emptyProposal({ roles: [{ action: "update", assetId, expectedVersion: 0, description: "" }] }),
      idempotencyKey: "explicit-description-clear",
      actor: human,
    });
    assert.deepEqual(metadata.bindings, []);
    const afterMetadata = await f.db("o_assets").where({ id: assetId }).first();
    assert.equal(afterMetadata.describe, "");
    assert.equal(afterMetadata.prompt, "keep prompt", "an omitted field is preserved");
    assert.ok(await f.db("o_scriptAssets").where({ scriptId: f.scriptId, assetId }).first(), "omitted bindings preserve links");

    const [lockedStoryboardId] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId: f.projectId, scriptId: f.scriptId, index: 0, prompt: "locked" });
    await f.db("o_assets2Storyboard").insert({ storyboardId: lockedStoryboardId, assetId });
    await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: lockedStoryboardId }).update({ locked: 1, lockedBy: human.id });
    await assert.rejects(
      applyAssetExtraction(f.db, {
        projectId: f.projectId,
        expectedWorkspaceVersion: 0,
        sourceScripts: [source(f.scriptId, episodeOne)],
        proposal: emptyProposal({ bindings: [{ scriptId: f.scriptId, assets: [] }] }),
        idempotencyKey: "locked-explicit-clear",
        actor: human,
      }),
      (error: any) => error instanceof AssetExtractionWorkspaceError && error.code === "LOCKED",
    );
    assert.ok(await f.db("o_scriptAssets").where({ scriptId: f.scriptId, assetId }).first());

    const model: StructuredScriptModel = {
      async generate(request) {
        // Simulate a still-supported legacy/manual path which changes content
        // without advancing ext_creative_state.
        await f.db("o_script").where({ id: f.secondScriptId, projectId: f.projectId }).update({ content: "human wins" });
        return {
          value: request.schema.parse({
            roles: [{ action: "reuse", assetId, expectedVersion: 1 }],
            scenes: [],
            props: [],
            bindings: [{ scriptId: f.secondScriptId, assets: [] }],
            summary: "stale clear",
          }),
          outputTokens: 8,
        };
      },
    };
    const helper = createAssetExtractionHelper({ db: f.db, model, loadInstructions: async () => "existing extraction instructions" });
    const run = context(f.db, f.projectId, "22222222-2222-4222-8222-222222222222");
    await assert.rejects(
      helper(run.ctx, { projectId: f.projectId, sourceScripts: [{ id: f.secondScriptId, expectedVersion: 0 }], request: "refresh", maxOutputTokens: 1000 }),
      (error: any) => error instanceof BuiltinRuntimeError && error.code === "STALE_VERSION",
    );
    assert.equal((await f.db("o_script").where({ id: f.secondScriptId }).first()).content, "human wins");
    assert.ok(await f.db("o_scriptAssets").where({ scriptId: f.secondScriptId, assetId }).first(), "late explicit clear must roll back");
    assert.equal(run.events.length, 0, "failed commit must not emit a saved artifact");
  } finally {
    await f.destroy();
  }
});
