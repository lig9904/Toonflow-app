import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { lockProjectTransaction } from "../src/lib/dbTransaction";
import { createImageGenerationService, ensureProductionImageJobSchema, type PrepareImageGenerationInput } from "../src/services/imageJobs/runtime";
import { ensureProductionStateSchema } from "../src/services/productionState";
import { snapshotImageReference } from "../src/services/imageJobs/referenceSnapshot";
import { ImageReviewService, type ImageReviewOptions } from "../src/services/imageReviews";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
async function fixture(overrides: Partial<ImageReviewOptions> = {}) {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db); await ensureProductionStateSchema(f.db); await ensureProductionImageJobSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { name: "image review", userId: 1 });
  const [scriptId] = await insertRowsReturningIds(f.db, "o_script", { projectId, name: "episode" });
  const [targetId] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId, scriptId, prompt: "幼态龙形神兽在画内；旁白角色不入画", videoDesc: "one dragon", state: "未生成", shouldGenerateImage: 1 });
  const media = new Map<string, Buffer>();
  const refs = [];
  for (const [index, color] of ["red", "blue"].entries()) {
    const [assetId] = await insertRowsReturningIds(f.db, "o_assets", { projectId, name: index ? "蓝色龙" : "红色龙", type: "role", describe: "nonhuman dragon", prompt: "dragon" });
    const filePath = `/${projectId}/reference-${index}.png`;
    const [imageId] = await insertRowsReturningIds(f.db, "o_image", { assetsId: assetId, filePath, state: "已完成" });
    await f.db("o_assets").where({ id: assetId }).update({ imageId });
    await f.db("o_scriptAssets").insert({ scriptId, assetId });
    media.set(filePath, await sharp({ create: { width: 64, height: 32, channels: 3, background: color } }).png().toBuffer());
    refs.push(snapshotImageReference(await f.db("o_assets").where({ id: assetId }).first(), filePath));
  }
  const output = await sharp({ create: { width: 64, height: 32, channels: 3, background: "green" } }).png().toBuffer();
  const calls: Parameters<ImageReviewOptions["generate"]>[0][] = [];
  const reviewOptions: ImageReviewOptions = {
    db: f.db, readImage: async (p) => { const bytes = media.get(p); if (!bytes) throw new Error("missing"); return bytes; },
    readPrompt: async () => ({ content: "Compare real output and reference images", version: "prompt-v1" }),
    resolveModel: async () => ({ key: "configured:deepseek-flash", modelName: "deepseek-flash", type: "text", enabled: true, baseUrl: "https://api.deepseek.com/v1" }),
    generate: async (request) => { calls.push(request); return { summary: "实际图像核验完成", findings: [] }; }, ...overrides,
  };
  const reviews = new ImageReviewService(reviewOptions);
  const jobs = createImageGenerationService({ db: f.db, imageReviews: reviews, pollMs: 10,
    providerFor: async () => ({ executionMode: "sync", fingerprint: "local-fixture", submit: async () => ({ outputBase64: output.toString("base64"), mimeType: "image/png" }), query: async () => { throw new Error("no query"); } }),
    download: async (_url, p) => { media.set(p, output); },
  });
  const input: PrepareImageGenerationInput = { generationKey: "image-review-fixture", projectId, modelKey: "fixture:image", outputPath: `/${projectId}/output.png`, target: { kind: "storyboard", id: targetId, scriptId },
    referenceAssets: refs, config: { prompt: "two nonhuman dragons; no subtitles", size: "1K", aspectRatio: "16:9", referenceList: refs.map((r) => ({ type: "image", base64: `data:image/png;base64,${media.get(r.filePath)!.toString("base64")}` })) } };
  return { ...f, projectId, scriptId, targetId, refs, media, output, calls, reviews, reviewOptions, jobs, input };
}

test("saved image queues exactly once, passes actual output then ordered reference pixels, and never calls model in save transaction", options, async () => {
  const f = await fixture();
  try {
    f.reviewOptions.generate = async (request) => {
      f.calls.push(request);
      await f.db.transaction(async (trx) => { await trx.raw("SET LOCAL lock_timeout = '200ms'"); await lockProjectTransaction(trx, f.projectId); });
      assert.equal((await f.db("ext_image_jobs").first()).status, "SUCCEEDED");
      return { summary: "checked real pixels", findings: [] };
    };
    const receipt = await f.jobs.prepareAndSubmit(f.input);
    assert.equal(receipt.status, "succeeded"); assert.equal(f.calls.length, 0);
    assert.equal((await f.reviews.list({ projectId: f.projectId }))[0].status, "queued");
    await Promise.all([f.reviews.enqueue({ projectId: f.projectId, jobId: receipt.jobId }), f.reviews.enqueue({ projectId: f.projectId, jobId: receipt.jobId })]);
    assert.equal((await f.db("ext_image_reviews")).length, 1);
    await f.reviews.runDue();
    assert.equal(f.calls.length, 1);
    const images = f.calls[0].content.filter((part) => part.type === "image");
    assert.equal(images.length, 3);
    for (const [index, channel] of [1, 0, 2].entries()) {
      const bytes = await sharp(Buffer.from(images[index].image.split(",")[1], "base64")).raw().toBuffer();
      assert(bytes[channel] > 100, `image ${index} keeps its source color`);
      for (const other of [0, 1, 2].filter((c) => c !== channel)) assert(bytes[other] < 15);
    }
    assert(f.calls[0].content.some((part) => part.type === "text" && part.text.includes("参考图1：红色龙")));
    const report = (await f.reviews.list({ projectId: f.projectId }))[0];
    assert.equal(report.status, "passed"); assert.equal(report.referenceCoverage, "complete"); assert.equal(report.selected, true); assert.equal(report.stale, false); assert.equal(report.promptVersion, "prompt-v1");
    const jobPayload = JSON.parse((await f.db("ext_image_jobs").first()).payload);
    assert.equal(jobPayload.config.referenceList[0].base64, undefined);
    assert.equal(typeof jobPayload.context.imageReview.references[0].sha256, "string");
    f.reviewOptions.readPrompt = async () => ({ content: "new instructions", version: "prompt-v2" });
    await f.jobs.recover(); await f.reviews.runDue();
    assert.equal(f.calls.length, 1); assert.equal((await f.db("ext_image_reviews")).length, 1);
  } finally { f.jobs.stop(); f.reviews.stop(); await f.destroy(); }
});

test("late human edits and changed reference files remain intact and partial evidence cannot pass", options, async () => {
  const f = await fixture();
  try {
    await f.jobs.prepareAndSubmit(f.input);
    await f.db("o_storyboard").where({ id: f.targetId }).update({ prompt: "human edit", filePath: "/human-chosen.png" });
    f.media.set(f.refs[0].filePath, f.output);
    await f.reviews.runDue();
    const report = (await f.reviews.list({ projectId: f.projectId }))[0];
    assert.equal(report.status, "issues"); assert.equal(report.referenceCoverage, "partial"); assert.equal(report.stale, true); assert.equal(report.selected, false);
    assert(report.findings.some((finding) => finding.code === "REFERENCE_UNAVAILABLE"));
    assert.equal(f.calls[0].content.filter((part) => part.type === "image").length, 2);
    const current = await f.db("o_storyboard").where({ id: f.targetId }).first();
    assert.equal(current.prompt, "human edit"); assert.equal(current.filePath, "/human-chosen.png");
  } finally { await f.destroy(); }
});

test("unsupported model is skipped and a failed or timed out review never fails image generation", options, async () => {
  const f = await fixture({ resolveModel: async () => ({ key: "custom:text", modelName: "text", enabled: true, type: "text" }) });
  try {
    const receipt = await f.jobs.prepareAndSubmit(f.input);
    await f.reviews.runDue();
    assert.equal((await f.reviews.list({ projectId: f.projectId }))[0].status, "skipped"); assert.equal(f.calls.length, 0);
    f.reviewOptions.resolveModel = async () => ({ key: "custom:vision", modelName: "vision", enabled: true, type: "text", supportsVision: true });
    f.reviewOptions.generate = async () => { throw new Error("secret provider error should not leak"); };
    await f.db("ext_image_reviews").where({ jobId: receipt.jobId }).update({ status: "queued", model: null, attempts: 0, invocationStartedAt: null });
    await f.reviews.runDue();
    const failed = (await f.reviews.list({ projectId: f.projectId }))[0];
    assert.equal(failed.status, "failed"); assert(!failed.summary.includes("secret"));
    assert.equal(failed.diagnostics?.code, "REVIEW_FAILED"); assert.equal(failed.diagnostics?.errorName, "Error"); assert(!JSON.stringify(failed).includes("secret provider error"));
    assert.equal((await f.jobs.get({ projectId: f.projectId, jobId: receipt.jobId })).status, "succeeded");
    assert.equal((await f.db("o_storyboard").where({ id: f.targetId }).first()).state, "已完成");
    f.reviewOptions.timeoutMs = 10; f.reviewOptions.generate = async () => new Promise(() => undefined);
    await f.db("ext_image_reviews").where({ jobId: receipt.jobId }).update({ status: "queued", model: null, attempts: 0, invocationStartedAt: null });
    await f.reviews.runDue();
    const timedOut = (await f.reviews.list({ projectId: f.projectId }))[0];
    assert.equal(timedOut.status, "failed"); assert.equal(timedOut.diagnostics?.code, "REVIEW_TIMEOUT");
    f.reviewOptions.timeoutMs = 1000;
    f.reviewOptions.generate = async () => ({ kind: "image-review-model-response", text: '{"summary":"private wrong schema"}', finishReason: "stop", usage: { outputTokens: 20 } });
    await f.db("ext_image_reviews").where({ jobId: receipt.jobId }).update({ status: "queued", model: null, attempts: 0, invocationStartedAt: null });
    await f.reviews.runDue();
    const malformed = (await f.reviews.list({ projectId: f.projectId }))[0];
    assert.equal(malformed.status, "failed"); assert.equal(malformed.diagnostics?.code, "REVIEW_OUTPUT_SCHEMA");
    assert.equal(malformed.diagnostics?.finishReason, "stop"); assert.equal(malformed.diagnostics?.fields?.[0].path, "findings");
    assert(!JSON.stringify(malformed).includes("private wrong schema"));
  } finally { await f.destroy(); }
});

test("restart repairs new post-save enqueue gaps, while historical jobs require explicit review", options, async () => {
  const f = await fixture();
  try {
    const receipt = await f.jobs.prepareAndSubmit(f.input);
    await f.db("ext_image_reviews").delete();
    await f.jobs.recover();
    assert.equal((await f.db("ext_image_reviews")).length, 1);
    await f.db("ext_image_reviews").delete();
    const job = await f.db("ext_image_jobs").where({ id: receipt.jobId }).first();
    const payload = JSON.parse(job.payload); delete payload.context.imageReview;
    await f.db("ext_image_jobs").where({ id: receipt.jobId }).update({ payload: JSON.stringify(payload) });
    await f.jobs.recover();
    assert.equal((await f.db("ext_image_reviews")).length, 0);
    await assert.rejects(f.reviews.enqueue({ projectId: f.projectId + 999, jobId: receipt.jobId }), /不属于/);
    await assert.rejects(f.reviews.enqueue({ projectId: f.projectId, scriptId: f.scriptId + 999, jobId: receipt.jobId }), /不属于/);
    await f.reviews.enqueue({ projectId: f.projectId, jobId: receipt.jobId }); await f.reviews.runDue();
    const report = (await f.reviews.list({ projectId: f.projectId }))[0];
    assert.equal(report.status, "issues"); assert.equal(report.referenceCoverage, "none");
    assert.equal(f.calls[0].content.filter((part) => part.type === "image").length, 1);
  } finally { await f.destroy(); }
});

test("leases suppress duplicate workers and never repeat uncertain paid calls; pre-invocation crashes recover", options, async () => {
  const f = await fixture();
  try {
    const receipt = await f.jobs.prepareAndSubmit(f.input);
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    f.reviewOptions.generate = async (request) => { f.calls.push(request); entered(); await new Promise<void>((resolve) => { release = resolve; }); return { summary: "late answer", findings: [] }; };
    const second = new ImageReviewService(f.reviewOptions);
    const firstRun = f.reviews.runDue(); await ready; await second.runDue();
    assert.equal(f.calls.length, 1);
    await f.db("ext_image_reviews").where({ jobId: receipt.jobId }).update({ leaseToken: "replacement-worker", leaseUntil: Date.now() - 1 });
    release(); await firstRun;
    assert.equal((await f.db("ext_image_reviews").first()).status, "running");
    f.reviewOptions.generate = async (request) => { f.calls.push(request); return { summary: "recovered answer", findings: [] }; };
    await second.runDue();
    assert.equal((await second.list({ projectId: f.projectId }))[0].status, "failed"); assert.equal(f.calls.length, 1);
    assert((await second.list({ projectId: f.projectId }))[0].summary.includes("未自动重复计费"));
    // Fixture now represents a worker lost during local preprocessing, before any model invocation.
    await f.db("ext_image_reviews").where({ jobId: receipt.jobId }).update({ status: "running", leaseToken: "preparing", leaseUntil: Date.now() - 1, invocationStartedAt: null, attempts: 1 });
    await second.runDue();
    const report = (await second.list({ projectId: f.projectId }))[0];
    assert.equal(report.status, "passed"); assert.equal(report.summary, "recovered answer"); assert.equal(f.calls.length, 2);
    await f.db("ext_image_reviews").where({ jobId: receipt.jobId }).update({ status: "running", leaseToken: "expired", leaseUntil: Date.now() - 1, invocationStartedAt: null, attempts: 2 });
    await second.runDue(); assert.equal((await second.list({ projectId: f.projectId }))[0].status, "failed");
    assert.equal(f.calls.length, 2);
  } finally { await f.destroy(); }
});

test("episode review listing includes its shared root asset images and excludes other episodes", options, async () => {
  const f = await fixture();
  try {
    const [otherScript] = await insertRowsReturningIds(f.db, "o_script", { projectId: f.projectId, name: "other episode" });
    const receipt = await f.jobs.prepareAndSubmit({ ...f.input, generationKey: "root-shared-image", target: { kind: "asset", id: f.refs[0].assetId }, referenceAssets: [], config: { ...f.input.config, referenceList: [] } });
    assert.equal((await f.reviews.list({ projectId: f.projectId, scriptId: f.scriptId })).length, 1);
    assert.equal((await f.reviews.list({ projectId: f.projectId, scriptId: otherScript })).length, 0);
    assert(await f.reviews.enqueue({ projectId: f.projectId, scriptId: f.scriptId, jobId: receipt.jobId }));
    await assert.rejects(f.reviews.enqueue({ projectId: f.projectId, scriptId: otherScript, jobId: receipt.jobId }), /不属于/);
  } finally { await f.destroy(); }
});

test("replacement artifact or cross-project reference ownership cannot reach the visual model", options, async () => {
  const f = await fixture();
  try {
    await f.jobs.prepareAndSubmit(f.input);
    f.media.set(f.input.outputPath!, f.media.get(f.refs[0].filePath)!);
    await f.reviews.runDue();
    assert.equal(f.calls.length, 0); assert.equal((await f.reviews.list({ projectId: f.projectId }))[0].status, "skipped");
    await f.db("ext_image_reviews").delete(); await f.jobs.recover();
    assert.equal((await f.reviews.list({ projectId: f.projectId }))[0].status, "skipped");
    const [otherProject] = await insertRowsReturningIds(f.db, "o_project", { name: "other", userId: 2 });
    await f.db("o_assets").where({ id: f.refs[0].assetId }).update({ projectId: otherProject });
    const snapshot = await f.reviews.prepare(f.input);
    assert(snapshot.references[0].unavailable); assert.equal(snapshot.references[0].filePath, undefined);
  } finally { await f.destroy(); }
});

test("generic ordered local reference paths retain real pixels; unknown slots stay partial and replay is stable", options, async () => {
  const f = await fixture();
  try {
    const input = { ...f.input, referenceAssets: undefined, referencePaths: [f.refs[0].filePath, undefined] };
    const receipt = await f.jobs.prepareAndSubmit(input);
    const replay = await f.jobs.prepare(input);
    assert.equal(replay.jobId, receipt.jobId);
    await f.reviews.runDue();
    assert.equal(f.calls[0].content.filter((part) => part.type === "image").length, 2);
    const review = (await f.reviews.list({ projectId: f.projectId }))[0];
    assert.equal(review.referenceCoverage, "partial"); assert.equal(review.status, "issues");
    const snapshot = JSON.parse((await f.db("ext_image_reviews").first()).snapshot);
    assert.equal(snapshot.references[0].filePath, f.refs[0].filePath); assert(snapshot.references[1].unavailable);
  } finally { await f.destroy(); }
});

test("legacy reservations replay old payload even when new callers supply reference metadata", options, async () => {
  const f = await fixture();
  try {
    const oldJobs = createImageGenerationService({ db: f.db, providerFor: async () => ({ executionMode: "sync", fingerprint: "local-fixture", submit: async () => ({ outputBase64: f.output.toString("base64"), mimeType: "image/png" }), query: async () => { throw new Error("no query"); } }), download: async () => undefined });
    const receipt = await oldJobs.prepare({ ...f.input, referenceAssets: undefined });
    const original = await f.db("ext_image_jobs").where({ id: receipt.jobId }).first();
    const replay = await f.jobs.prepare({ ...f.input, referencePaths: f.refs.map((item) => item.filePath) });
    assert.equal(replay.jobId, receipt.jobId);
    const latest = await f.db("ext_image_jobs").where({ id: receipt.jobId }).first();
    assert.equal(latest.payloadHash, original.payloadHash); assert.equal(latest.payload, original.payload);
    assert.equal(JSON.parse(latest.payload).context.imageReview, undefined);
  } finally { await f.destroy(); }
});

test("selected old storyboard and root asset reviews survive over 200 newer historical reviews with bounded hydration", options, async () => {
  const f = await fixture();
  try {
    const boardReceipt = await f.jobs.prepareAndSubmit(f.input);
    const rootReceipt = await f.jobs.prepareAndSubmit({ ...f.input, generationKey: "root-history-priority", outputPath: `/${f.projectId}/root-output.png`, target: { kind: "asset", id: f.refs[0].assetId }, referenceAssets: [], config: { ...f.input.config, referenceList: [] } });
    const board = await f.db("ext_image_reviews").where({ jobId: boardReceipt.jobId }).first();
    const root = await f.db("ext_image_reviews").where({ jobId: rootReceipt.jobId }).first();
    await f.db("ext_image_reviews").where({ id: board.id }).update({ createdAt: 1 });
    await f.db("ext_image_reviews").where({ id: root.id }).update({ createdAt: 2 });
    // The third report for the same selected artifact is the newest and must
    // win its one selected-priority slot; older duplicates remain history.
    await f.db("ext_image_reviews").insert({ ...board, id: "selected-board-latest", jobId: boardReceipt.jobId + 10000, createdAt: 3 });
    const history = Array.from({ length: 550 }, (_, index) => ({ ...board, id: `history-${String(index).padStart(4, "0")}`, jobId: boardReceipt.jobId + 20000 + index, artifactPath: `/${f.projectId}/old-candidate-${index}.png`, createdAt: 100 + index }));
    await f.db.batchInsert("ext_image_reviews", history, 100);
    const [otherScript] = await insertRowsReturningIds(f.db, "o_script", { projectId: f.projectId, name: "private other episode" });
    await f.db("ext_image_reviews").insert({ ...board, id: "other-episode-newest", jobId: boardReceipt.jobId + 30000, scriptId: otherScript, createdAt: 100000 });

    // Count hydrated reports to prove LIMIT occurs before per-report current-state reads.
    let hydrated = 0;
    const service = f.reviews as unknown as { report: (row: unknown) => Promise<unknown> };
    const report = service.report.bind(f.reviews);
    service.report = async (row) => { hydrated++; return report(row); };
    const reviews = await f.reviews.list({ projectId: f.projectId, scriptId: f.scriptId, limit: 200 });
    assert.equal(reviews.length, 200); assert.equal(hydrated, 200);
    assert.equal(reviews[0].id, "selected-board-latest"); assert.equal(reviews[0].selected, true);
    assert.equal(reviews[1].id, root.id); assert.equal(reviews[1].selected, true);
    assert.equal(reviews[2].id, "history-0549");
    assert(!reviews.some((item) => item.id === "other-episode-newest" || item.id === board.id));
    hydrated = 0;
    assert.equal((await f.reviews.list({ projectId: f.projectId, scriptId: f.scriptId })).length, 500);
    assert.equal(hydrated, 500);
  } finally { await f.destroy(); }
});
