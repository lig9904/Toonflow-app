import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureProductionStateSchema } from "../src/services/productionState";
import { ImageJobService } from "../src/services/imageJobs";
import { createImageGenerationService, ensureProductionImageJobSchema } from "../src/services/imageJobs/runtime";
import { imageReferencesMatch, snapshotImageReference } from "../src/services/imageJobs/referenceSnapshot";
import { ImageReviewService } from "../src/services/imageReviews";
import { BuiltinAgentRuntime, ensureBuiltinAgentRuntimeSchema } from "../src/services/builtinAgentRuntime";
import { generateRootAssetImage } from "../src/services/rootAssetImages";
import { ensureTeamSchema } from "../src/services/team";
import { advanceCreativeState } from "../src/services/creativeWorkspace";
import { lockProjectTransaction } from "../src/lib/dbTransaction";

const options = { timeout: 30_000 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGN8AAAAASUVORK5CYII=", "base64");

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureProductionStateSchema(f.db);
  await ensureProductionImageJobSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { name: "image workflow audit", userId: 1 });
  const [scriptId] = await insertRowsReturningIds(f.db, "o_script", { projectId, name: "episode" });
  return { ...f, projectId, scriptId };
}

test("a changed parent reference keeps the old derived result as an unselected candidate", options, async () => {
  const f = await fixture();
  try {
    const [parentId, childId] = await insertRowsReturningIds(f.db, "o_assets", [
      { projectId: f.projectId, name: "parent", type: "role", describe: "original identity" },
      { projectId: f.projectId, name: "child", type: "role", describe: "derived state" },
    ]);
    await f.db("o_assets").where({ id: childId }).update({ assetsId: parentId });
    await f.db("o_scriptAssets").insert([{ scriptId: f.scriptId, assetId: parentId }, { scriptId: f.scriptId, assetId: childId }]);
    const [oldImageId, newImageId] = await insertRowsReturningIds(f.db, "o_image", [
      { assetsId: parentId, filePath: `/${f.projectId}/old.png`, state: "已完成" },
      { assetsId: parentId, filePath: `/${f.projectId}/new.png`, state: "已完成" },
    ]);
    await f.db("o_assets").where({ id: parentId }).update({ imageId: oldImageId });
    const reference = snapshotImageReference(await f.db("o_assets").where({ id: parentId }).first(), `/${f.projectId}/old.png`);
    const generation = createImageGenerationService({
      db: f.db,
      providerFor: async () => ({
        executionMode: "sync",
        fingerprint: "audit-sync",
        submit: async () => {
          await f.db("o_assets").where({ id: parentId }).update({ imageId: newImageId, describe: "human changed identity" });
          return { outputBase64: png.toString("base64"), mimeType: "image/png" as const };
        },
        query: async () => { throw new Error("not used"); },
      }),
      download: async () => undefined,
    });
    const receipt = await generation.prepareAndSubmit({
      generationKey: "audit-stale-parent",
      projectId: f.projectId,
      modelKey: "audit:image",
      referenceAssets: [reference],
      target: { kind: "asset", id: childId, scriptId: f.scriptId },
      config: { prompt: "derived from old parent", referenceList: [{ type: "image", base64: `data:image/png;base64,${png.toString("base64")}` }], size: "1K", aspectRatio: "16:9" },
    });

    assert.equal(await imageReferencesMatch(f.db, f.projectId, [reference]), false);
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.selected, false);
    assert.equal((await f.db("o_assets").where({ id: childId }).first()).imageId, null);
    assert(Number((await f.db("ext_image_job_bindings").where({ jobId: receipt.jobId }).first()).candidateImageId) > 0);
  } finally { await f.destroy(); }
});

test("a root asset may replace its claimed candidate while retaining its own reference snapshot", options, async () => {
  const f = await fixture();
  try {
    const [assetId] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, name: "root", type: "role", describe: "same identity" });
    const [oldImageId] = await insertRowsReturningIds(f.db, "o_image", { assetsId: assetId, filePath: `/${f.projectId}/root-old.png`, state: "已完成" });
    await f.db("o_assets").where({ id: assetId }).update({ imageId: oldImageId });
    const generation = createImageGenerationService({ db: f.db, providerFor: async () => ({ executionMode: "sync", fingerprint: "audit-root-sync", submit: async () => ({ outputBase64: png.toString("base64"), mimeType: "image/png" as const }), query: async () => { throw new Error("unused"); } }), download: async () => undefined });
    const receipt = await generateRootAssetImage(f.db, generation, { projectId: f.projectId, assetId, type: "role", name: "root", prompt: "same identity", model: "audit:image", resolution: "1K", base64: `data:image/png;base64,${png.toString("base64")}`, generationKey: "audit-root-self-reference", expectedVersion: 0 });
    const selected = await f.db("o_assets as asset").join("o_image as image", "image.id", "asset.imageId").where("asset.id", assetId).select("image.id", "image.filePath").first();
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.selected, true);
    assert.notEqual(Number(selected.id), oldImageId);
    assert.equal(selected.filePath, receipt.artifactPath);
  } finally { await f.destroy(); }
});

test("an old root-image request is rejected before acceptance after another user updates the asset source", options, async () => {
  const f = await fixture();
  try {
    const [assetId] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, name: "root", type: "role", prompt: "source A", describe: "identity" });
    let submits = 0;
    const generation = createImageGenerationService({ db: f.db, providerFor: async () => ({ executionMode: "sync", fingerprint: "audit-source-version", submit: async () => { submits++; return { outputBase64: png.toString("base64"), mimeType: "image/png" as const }; }, query: async () => { throw new Error("unused"); } }), download: async () => undefined });
    await f.db.transaction(async (trx) => {
      await lockProjectTransaction(trx, f.projectId);
      await trx("o_assets").where({ id: assetId, projectId: f.projectId }).update({ prompt: "source B" });
      await advanceCreativeState(trx, { entityType: "asset", entityId: assetId, projectId: f.projectId, expectedVersion: 0, actor: { kind: "human", id: "human:2" } });
    });
    await assert.rejects(generateRootAssetImage(f.db, generation, { projectId: f.projectId, assetId, type: "role", name: "root", prompt: "source A", model: "audit:image", resolution: "1K", generationKey: "audit-old-request-before-accept", expectedVersion: 0 }), (error: any) => error?.code === "VERSION_CONFLICT");
    assert.equal(submits, 0);
    assert.equal((await f.db("ext_image_jobs")).length, 0);
    assert.equal((await f.db("o_assets").where({ id: assetId }).first()).prompt, "source B");
  } finally { await f.destroy(); }
});

test("a root-image result from an obsolete accepted source remains a candidate and completed replay does not submit again", options, async () => {
  const f = await fixture();
  try {
    const [assetId] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, name: "root", type: "role", prompt: "source A", describe: "identity" });
    let submits = 0;
    const generation = createImageGenerationService({ db: f.db, providerFor: async () => ({ executionMode: "sync", fingerprint: "audit-source-window", submit: async () => {
      submits++;
      await f.db.transaction(async (trx) => {
        await lockProjectTransaction(trx, f.projectId);
        await trx("o_assets").where({ id: assetId, projectId: f.projectId }).update({ prompt: "source B" });
        await advanceCreativeState(trx, { entityType: "asset", entityId: assetId, projectId: f.projectId, expectedVersion: 0, actor: { kind: "human", id: "human:2" } });
      });
      return { outputBase64: png.toString("base64"), mimeType: "image/png" as const };
    }, query: async () => { throw new Error("unused"); } }), download: async () => undefined });
    const input = { projectId: f.projectId, assetId, type: "role" as const, name: "root", prompt: "source A", model: "audit:image", resolution: "1K", generationKey: "audit-source-window-result", expectedVersion: 0 };
    const first = await generateRootAssetImage(f.db, generation, input);
    assert.equal(first.status, "succeeded");
    assert.equal(first.selected, false);
    assert.equal((await f.db("o_assets").where({ id: assetId }).first()).prompt, "source B");
    assert.equal((await f.db("o_assets").where({ id: assetId }).first()).imageId, null);
    const binding = await f.db("ext_image_job_bindings").where({ jobId: first.jobId }).first();
    assert.equal(Number(binding.sourceVersion), 0);
    assert(Number(binding.candidateImageId) > 0);
    const replay = await generateRootAssetImage(f.db, generation, input);
    assert.equal(replay.jobId, first.jobId);
    assert.equal(replay.selected, false);
    assert.equal(submits, 1);
  } finally { await f.destroy(); }
});

test("two image workers fence late pending and failed callbacks after success", options, async () => {
  const f = await fixture();
  try {
    for (const lateStatus of ["pending", "failed"] as const) {
      let now = 1_000;
      let release!: (value: { status: "pending" } | { status: "failed"; error: string }) => void;
      let entered!: () => void;
      let queryCalls = 0;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const delayed = new Promise<{ status: "pending" } | { status: "failed"; error: string }>((resolve) => { release = resolve; });
      const first = new ImageJobService(f.db, {
        schedule: false,
        initialPollDelayMs: 0,
        processingLeaseMs: 100,
        now: () => now,
        providerFor: async () => ({ fingerprint: `audit-async-${lateStatus}`, submit: async () => ({ taskId: `accepted-${lateStatus}` }), query: async () => {
          if (++queryCalls === 1) return { status: "pending" as const };
          entered();
          return delayed;
        } }),
        download: async () => undefined,
      });
      const second = new ImageJobService(f.db, {
        schedule: false,
        initialPollDelayMs: 0,
        processingLeaseMs: 100,
        now: () => now,
        providerFor: async () => ({ fingerprint: `audit-async-${lateStatus}`, submit: async () => { throw new Error("must not resubmit"); }, query: async () => ({ status: "succeeded" as const, outputUrl: "https://fixture.invalid/image.png" }) }),
        download: async () => undefined,
      });
      const reserved = await first.reserve({ projectId: f.projectId, modelKey: "audit:async", idempotencyKey: `audit-two-workers-${lateStatus}`, outputPath: `/${f.projectId}/worker-${lateStatus}.png`, config: { prompt: "one image" } });
      await first.submitReserved(reserved.job.id);
      const slow = first.continueKnown(reserved.job.id);
      await ready;
      now += 101;
      await second.continueKnown(reserved.job.id);
      assert.equal((await first.get(reserved.job.id)).status, "SUCCEEDED");
      release(lateStatus === "pending" ? { status: "pending" } : { status: "failed", error: "late rejection" });
      await slow;
      assert.equal((await first.get(reserved.job.id)).status, "SUCCEEDED");
    }
  } finally { await f.destroy(); }
});

test("image review belongs to its builtin run and consumes no model call after cancellation or exhausted budget", options, async () => {
  const f = await fixture();
  try {
    await ensureBuiltinAgentRuntimeSchema(f.db);
    const [assetId] = await insertRowsReturningIds(f.db, "o_assets", { projectId: f.projectId, name: "child", type: "role", describe: "current child" });
    await f.db("o_scriptAssets").insert({ scriptId: f.scriptId, assetId });
    const runId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    await f.db("ext_builtin_runs").insert({
      id: runId, agentType: "productionAgent", projectId: f.projectId, scriptId: f.scriptId, requestedBy: 1, executionUserId: 1,
      prompt: "audit", idempotencyKey: "audit-run", requestHash: "audit", status: "running",
      limits: JSON.stringify({ maxModelCalls: 1, maxToolSteps: 40, maxOutputTokens: 4096, maxImageGenerations: 1, maxVideoGenerations: 0 }),
      modelCalls: 1, createdAt: 1, updatedAt: 1,
    });
    let reviewCalls = 0;
    const images = new Map<string, Buffer>();
    const reviews = new ImageReviewService({
      db: f.db,
      readImage: async (path) => { const value = images.get(path); if (!value) throw new Error("missing"); return value; },
      readPrompt: async () => ({ content: "review pixels", version: "v1" }),
      resolveModel: async () => ({ key: "audit:vision", modelName: "vision", enabled: true, type: "text", supportsVision: true }),
      generate: async () => { reviewCalls++; return { summary: "mock result", findings: [] }; },
    });
    const generation = createImageGenerationService({
      db: f.db,
      imageReviews: reviews,
      providerFor: async () => ({ executionMode: "sync", fingerprint: "audit-sync-review", submit: async () => ({ outputBase64: png.toString("base64"), mimeType: "image/png" as const }), query: async () => { throw new Error("unused"); } }),
      download: async (_url, path) => { images.set(path, png); },
    });
    const output = await generation.prepareAndSubmit({ generationKey: "audit-cancelled-run-review", projectId: f.projectId, modelKey: "audit:image", builtinRun: { id: runId, inputRevision: 0 }, target: { kind: "asset", id: assetId, scriptId: f.scriptId }, config: { prompt: "current child", size: "1K", aspectRatio: "16:9" } });
    await f.db("ext_builtin_runs").where({ id: runId }).update({ status: "cancelled" });
    await reviews.runDue();

    const persistedRun = await f.db("ext_builtin_runs").where({ id: runId }).first();
    const [review] = await reviews.list({ projectId: f.projectId, jobId: output.jobId });
    assert.equal(reviewCalls, 0);
    assert.equal(Number(persistedRun.modelCalls), 1);
    assert.equal(review.status, "skipped");
    assert.match(review.summary, /取消|额度/);
    const rawReview = await f.db("ext_image_reviews").where({ jobId: output.jobId }).first();
    assert.equal(rawReview.runId, runId);
    assert.equal(Number(rawReview.actorId), 1);
    assert.equal(rawReview.billingOwnerType, "builtin_run");

    await f.db("ext_builtin_runs").where({ id: runId }).update({ status: "succeeded" });
    await f.db("ext_image_reviews").where({ jobId: output.jobId }).update({ status: "queued", summary: "", findings: "[]", attempts: 0, nextAttemptAt: null, reviewedAt: null });
    await reviews.runDue();
    const [budgetReview] = await reviews.list({ projectId: f.projectId, jobId: output.jobId });
    assert.equal(reviewCalls, 0);
    assert.equal(budgetReview.status, "skipped");
    assert.match(budgetReview.summary, /额度/);

    await ensureTeamSchema(f.db, { bootstrapAdminUserId: 1 });
    await f.db("team_users").where({ user_id: 1 }).update({ enabled: false });
    await f.db("ext_builtin_runs").where({ id: runId }).update({ status: "running", modelCalls: 0 });
    await f.db("ext_image_reviews").where({ jobId: output.jobId }).update({ status: "queued", summary: "", findings: "[]", attempts: 0, nextAttemptAt: null, reviewedAt: null });
    await reviews.runDue();
    assert.equal(reviewCalls, 0);
    assert.match((await f.db("ext_image_reviews").where({ jobId: output.jobId }).first()).summary, /权限/);
    await f.db("team_users").where({ user_id: 1 }).update({ enabled: true });

    await f.db("ext_builtin_runs").where({ id: runId }).update({ status: "paused", modelCalls: 0 });
    await f.db("ext_image_reviews").where({ jobId: output.jobId }).update({ status: "queued", summary: "", findings: "[]", attempts: 0, nextAttemptAt: null, reviewedAt: null });
    await reviews.runDue();
    assert.equal(reviewCalls, 0);
    assert.equal((await f.db("ext_image_reviews").where({ jobId: output.jobId }).first()).status, "queued");
    await f.db("ext_builtin_runs").where({ id: runId }).update({ status: "running" });
    await f.db("ext_image_reviews").where({ jobId: output.jobId }).update({ nextAttemptAt: null });
    await reviews.runDue();
    assert.equal(reviewCalls, 1);
    const billedRun = await f.db("ext_builtin_runs").where({ id: runId }).first();
    assert.equal(billedRun.modelCalls, 1);
    assert.equal(billedRun.version, 1);
    assert.equal(billedRun.lastSequence, 1);
    const billingEvent = await f.db("ext_builtin_run_events").where({ runId, sequence: 1 }).first();
    assert.equal(billingEvent.type, "model.attached.reserved");
    assert.deepEqual(billingEvent.data, { actorId: 1, projectId: f.projectId, scriptId: f.scriptId, modelCalls: 1, maxModelCalls: 1 });
    const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: async () => ({}) });
    await assert.rejects(runtime.control(runId, 0, "pause"), (error: any) => error?.code === "STALE_VERSION");
    const paused = await runtime.control(runId, 1, "pause");
    assert.equal(paused.status, "paused");
    assert.equal(paused.version, 2);
    assert.deepEqual((await runtime.events(runId)).map((event) => [event.sequence, event.type]), [[1, "model.attached.reserved"], [2, "run.status"]]);
  } finally { await f.destroy(); }
});
