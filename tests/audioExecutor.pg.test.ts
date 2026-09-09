import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureBuiltinAgentRuntimeSchema, BuiltinAgentRuntime } from "../src/services/builtinAgentRuntime";
import { ensureProductionStateSchema } from "../src/services/productionState";
import { ensureRoleAudioWorkspaceSchema, prepareAudioMatchContext, configureAudioMatchRunStarter, startAudioMatchRun } from "../src/services/roleAudioWorkspace";
import { createAudioMatchExecutor } from "../src/services/builtinAgent/audioExecutor";
import type { StructuredScriptModel } from "../src/services/builtinAgent/scriptExecutor";
import { defaultBuiltinRunLimits } from "../src/services/builtinAgent/contracts";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureProductionStateSchema(f.db);
  await ensureBuiltinAgentRuntimeSchema(f.db);
  await ensureRoleAudioWorkspaceSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Voice fixture" });
  const [roleId] = await insertRowsReturningIds(f.db, "o_assets", { projectId, type: "role", name: "Guide", describe: "Adult guide" });
  const [familyId] = await insertRowsReturningIds(f.db, "o_assets", { projectId, type: "audio", name: "Voice family" });
  const [childId] = await insertRowsReturningIds(f.db, "o_assets", { projectId, assetsId: familyId, type: "audio", name: "Voice sample" });
  const [imageId] = await insertRowsReturningIds(f.db, "o_image", { assetsId: childId, type: "audio", filePath: `/${projectId}/sample.wav`, state: "已完成" });
  await f.db("o_assets").where({ id: childId }).update({ imageId });
  return { ...f, projectId, roleId, familyId, childId };
}

test("audio match is a real builtin run, commits family binding, and replays after the role version changes", options, async () => {
  const f = await fixture(); let calls = 0;
  try {
    const model: StructuredScriptModel = { async generate(req) { calls++; assert.equal(req.role, "universalAi"); return { value: req.schema.parse({ selections: [{ roleAssetId: f.roleId, audioFamilyId: f.familyId, reason: "voice matches" }], summary: "Matched" }), outputTokens: 12 }; } };
    const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: createAudioMatchExecutor({ db: f.db, model }) });
    configureAudioMatchRunStarter(async ({ requestedBy, idempotencyKey, context }) => {
      const result = await runtime.create({ agentType: "productionAgent", projectId: context.projectId, requestedBy, idempotencyKey: `audio:${idempotencyKey}`, prompt: "match voices", intent: { phase: "matchAudio", context }, limits: defaultBuiltinRunLimits });
      return { run: { ...result.run }, reused: result.reused };
    }, async (userId, key) => { const run = await runtime.findByIdempotency(userId, `audio:${key}`); return run ? { run: { ...run }, reused: true } : undefined; });
    const input = { projectId: f.projectId, items: [{ roleAssetId: f.roleId, expectedVersion: 0 }], idempotencyKey: "audio-batch-start" };
    const created = await startAudioMatchRun(f.db, input, 1);
    assert.equal(created.run.status, "queued"); assert.equal(calls, 0);
    await runtime.runOnce();
    assert.equal((await runtime.get(created.run.id)).status, "succeeded");
    const selected = await f.db("o_assetsRole2Audio").where({ assetsRoleId: f.roleId }).first();
    assert.equal(Number(selected.assetsAudioId), f.familyId);
    const repeated = await startAudioMatchRun(f.db, input, 1);
    assert.equal(repeated.run.id, created.run.id); assert.equal(repeated.reused, true); assert.equal(calls, 1);
    await assert.rejects(startAudioMatchRun(f.db, { ...input, items: [{ roleAssetId: f.roleId, expectedVersion: 1 }] }, 1), /不同|冲突|不一致/);
  } finally { await f.destroy(); }
});

test("no suitable audio preserves the old binding and wrong-family model output cannot replace it", options, async () => {
  const f = await fixture();
  try {
    await f.db("o_assetsRole2Audio").insert({ assetsRoleId: f.roleId, assetsAudioId: f.familyId });
    const context = await prepareAudioMatchContext(f.db, { projectId: f.projectId, items: [{ roleAssetId: f.roleId, expectedVersion: 0 }], idempotencyKey: "audio-snapshot" });
    for (const selected of [null, f.childId]) {
      const model: StructuredScriptModel = { async generate(req) { return { value: req.schema.parse({ selections: [{ roleAssetId: f.roleId, audioFamilyId: selected, reason: "test" }], summary: "test" }), outputTokens: 10 }; } };
      const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: createAudioMatchExecutor({ db: f.db, model }) });
      const created = await runtime.create({ agentType: "productionAgent", projectId: f.projectId, requestedBy: 1, prompt: "match", idempotencyKey: `audio-invalid-${selected}`, intent: { phase: "matchAudio", context }, limits: defaultBuiltinRunLimits });
      await runtime.runOnce();
      assert.equal((await runtime.get(created.run.id)).status, selected === null ? "succeeded" : "failed");
      assert.equal(Number((await f.db("o_assetsRole2Audio").where({ assetsRoleId: f.roleId }).first()).assetsAudioId), f.familyId);
    }
  } finally { await f.destroy(); }
});
