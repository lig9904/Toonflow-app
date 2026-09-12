import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureTrackWorkspaceSchema, updateTrackPrompt } from "../src/services/trackWorkspace";
import { getCreativeState } from "../src/services/creativeWorkspace";
import { StructuredModelOutputError } from "../src/lib/structuredModelOutput";
import { ensureImageReviewSchema } from "../src/services/imageReviews";
import { executeVideoPromptJob, markVideoPromptPreparationFailed, prepareVideoPromptJob, ensureVideoPromptJobSchema } from "../src/services/videoPromptJobs";
import { prepareVideoPromptForGeneration } from "../src/services/videoPromptCompositionService";
import { saveVideoModeIntent, saveVideoReferences } from "../src/services/videoModeResolution";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };

test("startup resolves pre-receipt orphan prompt states without deleting old text", options, async () => {
  const f = await fixture();
  try {
    await f.db("o_videoTrack").where({ id: f.firstTrack }).update({ state: "生成中", prompt: "old retained prompt" });
    await ensureVideoPromptJobSchema(f.db);
    const row = await f.db("o_videoTrack").where({ id: f.firstTrack }).first();
    assert.equal(row.state, "生成失败"); assert.equal(row.prompt, "old retained prompt"); assert.match(row.reason, /重启/);
  } finally { await f.destroy(); }
});

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureTrackWorkspaceSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Prompt jobs", videoModel: "fixture:model" });
  const [scriptId] = await insertRowsReturningIds(f.db, "o_script", { projectId, name: "Episode", content: "source" });
  const [firstTrack, secondTrack] = await insertRowsReturningIds(f.db, "o_videoTrack", [
    { projectId, scriptId, duration: 3, state: "未生成", prompt: "" },
    { projectId, scriptId, duration: 4, state: "未生成", prompt: "" },
  ]);
  await f.db("o_storyboard").insert([
    { projectId, scriptId, trackId: firstTrack, index: 0, duration: "3", prompt: "灵兽说：我已知道", videoDesc: "面部特写" },
    { projectId, scriptId, trackId: secondTrack, index: 0, duration: "4", prompt: "雪璃转身", videoDesc: "海岸远景", filePath: "/fixture/reference.png" },
  ]);
  return { ...f, projectId, scriptId, firstTrack, secondTrack };
}

test("a pending prompt job cannot acknowledge or overwrite after its saved mode/reference revision changes", options, async () => {
  const f = await fixture();
  try {
    const board = await f.db("o_storyboard").where({ trackId: f.secondTrack }).first();
    const references = [{ id: Number(board.id), sources: "storyboard" as const, fileType: "image" as const, purpose: "first_frame" as const }];
    await saveVideoReferences(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.secondTrack, references, expectedRevision: 0, idempotencyKey: "prompt-race-refs" }, "human:1");
    await saveVideoModeIntent(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.secondTrack, modeIntent: "singleImage", expectedRevision: 1, idempotencyKey: "prompt-race-mode" }, "human:1");
    const prepared = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.secondTrack, model: "fixture:model", mode: "singleImage", info: references, modeIntentSnapshot: { modeIntent: "singleImage", revision: 2 }, idempotencyKey: "pending-prompt-selection-race", expectedVersion: 0 });
    await saveVideoModeIntent(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.secondTrack, modeIntent: "auto", expectedRevision: 2, idempotencyKey: "prompt-race-mode-new" }, "human:2");
    const completed = await executeVideoPromptJob(f.db, prepared.job.id, async () => "雪璃转身，@图片1 展示海岸远景");
    assert.equal(completed.state, "failed"); assert.match(completed.reason ?? "", /参考身份已变化/); assert.equal(completed.resultPrompt, "雪璃转身，@图片1 展示海岸远景");
    assert.equal((await f.db("ext_video_prompt_jobs").where({ id: prepared.job.id }).first()).resultPrompt, "雪璃转身，@图片1 展示海岸远景");
    assert.equal((await f.db("o_videoTrack").where({ id: f.secondTrack }).first()).prompt, "");
    const selection = await f.db("ext_video_mode_intents").where({ trackId: f.secondTrack }).first();
    assert.equal(Number(selection.promptReferenceRevision), 0, "late prompt must not acknowledge an unseen selection revision");
  } finally { await f.destroy(); }
});

test("empty visual info still uses each track's complete source storyboard", options, async () => {
  const f = await fixture();
  try {
    const first = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-source-first", expectedVersion: 0 });
    const second = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.secondTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-source-second", expectedVersion: 0 });
    assert.match(first.job.promptInput, /灵兽说：我已知道/);
    assert.match(first.job.promptInput, /3秒/);
    assert.doesNotMatch(first.job.promptInput, /雪璃转身/);
    assert.match(second.job.promptInput, /雪璃转身/);
    assert.doesNotMatch(second.job.promptInput, /灵兽说：我已知道/);
  } finally { await f.destroy(); }
});

test("completed idempotent retry returns the saved result after its own CAS version advance", options, async () => {
  const f = await fixture();
  try {
    const input = { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-completed-retry", expectedVersion: 0 };
    const prepared = await prepareVideoPromptJob(f.db, input);
    let calls = 0;
    await executeVideoPromptJob(f.db, prepared.job.id, async () => { calls += 1; return "saved once；灵兽说：我已知道"; });
    const retry = await prepareVideoPromptJob(f.db, input);
    assert.equal(retry.reused, true);
    const result = await executeVideoPromptJob(f.db, retry.job.id, async () => { calls += 1; return "duplicate"; });
    assert.equal(result.resultPrompt, "saved once；灵兽说：我已知道");
    assert.equal(calls, 1);
  } finally { await f.destroy(); }
});

test("a stale version is rejected before prompt preparation without a failure receipt or model call", options, async () => {
  const f = await fixture();
  try {
    const oldVersion = (await getCreativeState(f.db, "track", f.firstTrack, f.projectId)).version;
    await updateTrackPrompt(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, expectedVersion: oldVersion, prompt: "human prompt must survive", idempotencyKey: "human-before-stale-prepare" }, { kind: "human", id: "human:2" });
    const stateBeforeStaleRequest = (await f.db("o_videoTrack").where({ id: f.firstTrack }).first()).state;
    await assert.rejects(prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "stale-before-prepare", expectedVersion: oldVersion }), (error: any) => error?.code === "VERSION_CONFLICT");
    const current = await f.db("o_videoTrack").where({ id: f.firstTrack }).first();
    assert.equal(current.prompt, "human prompt must survive");
    assert.equal(current.state, stateBeforeStaleRequest);
    assert.equal(await f.db("ext_video_prompt_jobs").where({ trackId: f.firstTrack }).count("id as count").first().then((row) => Number(row?.count)), 0);
  } finally { await f.destroy(); }
});

test("shared generation preparation preserves a saved prompt and reports newer storyboard state without model calls", options, async () => {
  const f = await fixture();
  try {
    await updateTrackPrompt(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, expectedVersion: 0, prompt: "人工保存正文：逆光，灵兽说：我已知道", idempotencyKey: "shared-human-save" }, { kind: "human", id: "human:saved-prompt" });
    const trackState = await getCreativeState(f.db, "track", f.firstTrack, f.projectId);
    const board = await f.db("o_storyboard").where({ trackId: f.firstTrack }).first();
    await f.db("ext_entity_state").insert({ entityType: "storyboard", entityId: Number(board.id), projectId: f.projectId, version: 1, reviewState: "draft", locked: 0, updatedBy: "human:source-newer", updatedAt: Number(trackState.updatedAt) + 1 }).onConflict(["entityType", "entityId"]).merge();
    let modelCalls = 0;
    const input = { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], generation: { duration: 4, resolution: "480p", audio: false }, idempotencyKey: "shared-saved-prompt", expectedVersion: trackState.version };
    const result = await prepareVideoPromptForGeneration(f.db, input, {
      prepare: async () => { throw new Error("must not prepare"); }, generateDraft: async () => "must not generate", reviewDraft: async () => { throw new Error("must not review"); },
    }, {
      generateDraft: async () => { modelCalls += 1; return "must not run"; }, reviewDraft: async () => { modelCalls += 1; throw new Error("must not run"); },
    });
    assert.equal(result.prompt, "人工保存正文：逆光，灵兽说：我已知道");
    assert.equal(result.source, "saved"); assert.equal(result.stale, true); assert.equal(modelCalls, 0);
    assert(result.promptReview.findings.some((finding) => finding.code === "PROMPT_SOURCE_STALE"));
  } finally { await f.destroy(); }
});

test("shared generation preparation composes, reviews and saves only when the stored prompt is empty", options, async () => {
  const f = await fixture();
  try {
    let generationCalls = 0, reviewCalls = 0;
    const input = { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], generation: { duration: 4, resolution: "480p", audio: false }, idempotencyKey: "shared-empty-prompt", expectedVersion: 0 };
    const result = await prepareVideoPromptForGeneration(f.db, input, {
      prepare: (value) => prepareVideoPromptJob(f.db, value, { compose: async () => frozenComposition() }),
      generateDraft: async () => "灵兽说：我已知道",
      reviewDraft: async (_job, draft) => ({ prompt: draft, review: { status: "passed", findings: [], summary: "ok", revised: false, reviewedAt: Date.now() } }),
    }, {
      generateDraft: async (_job, invoke) => { generationCalls += 1; return invoke(); },
      reviewDraft: async (_job, _draft, invoke) => { reviewCalls += 1; return invoke(); },
    });
    assert.equal(result.source, "generated"); assert.equal(result.prompt, "灵兽说：我已知道"); assert.equal(result.trackVersion, 1);
    assert.equal(generationCalls, 1); assert.equal(reviewCalls, 1);
    assert.equal((await f.db("o_videoTrack").where({ id: f.firstTrack }).first()).prompt, "灵兽说：我已知道");
  } finally { await f.destroy(); }
});

test("the current track prompt remains authoritative after a successful job is manually edited", options, async () => {
  const f = await fixture();
  try {
    const input = { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-authoritative-current", expectedVersion: 0 };
    const prepared = await prepareVideoPromptJob(f.db, input);
    await executeVideoPromptJob(f.db, prepared.job.id, async () => "generated result；灵兽说：我已知道");
    const version = (await getCreativeState(f.db, "track", f.firstTrack, f.projectId)).version;
    await updateTrackPrompt(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, expectedVersion: version, prompt: "human replacement", idempotencyKey: "prompt-authoritative-edit" }, { kind: "human", id: "human:1" });
    const current = await f.db("o_videoTrack").where({ id: f.firstTrack, projectId: f.projectId, scriptId: f.scriptId }).first("prompt");
    const savedJob = await f.db("ext_video_prompt_jobs").where({ id: prepared.job.id }).first("resultPrompt");
    assert.equal(savedJob.resultPrompt, "generated result；灵兽说：我已知道");
    assert.equal(current.prompt, "human replacement");
  } finally { await f.destroy(); }
});

test("cross-track storyboard references are legal while cross-project references are rejected", options, async () => {
  const f = await fixture();
  try {
    const otherStoryboard = await f.db("o_storyboard").where({ trackId: f.secondTrack }).first();
    const accepted = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "singleImage", info: [{ id: Number(otherStoryboard.id), sources: "storyboard", fileType: "image" }], idempotencyKey: "prompt-cross-track-ref", expectedVersion: 0 });
    assert.match(accepted.job.promptInput, new RegExp(String(otherStoryboard.id)));
    const [otherProject] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Other" });
    const [foreignAsset] = await insertRowsReturningIds(f.db, "o_assets", { projectId: otherProject, name: "foreign", type: "role" });
    await assert.rejects(prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [{ id: foreignAsset, sources: "assets" }], idempotencyKey: "prompt-foreign-ref", expectedVersion: 0 }), /不属于当前项目/);
  } finally { await f.destroy(); }
});

test("track prompt jobs save independently, isolate failures, and deduplicate concurrent retries", options, async () => {
  const f = await fixture();
  try {
    const first = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-independent-first", expectedVersion: 0 });
    const second = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.secondTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-independent-second", expectedVersion: 0 });
    let calls = 0;
    const firstRun = await Promise.all([
      executeVideoPromptJob(f.db, first.job.id, async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return "first result；灵兽说：我已知道"; }),
      executeVideoPromptJob(f.db, first.job.id, async () => { calls += 1; return "duplicate result"; }),
    ]);
    assert.equal(firstRun[0].resultPrompt, "first result；灵兽说：我已知道");
    assert.equal(firstRun[1].resultPrompt, "first result；灵兽说：我已知道");
    assert.equal(calls, 1);
    await assert.rejects(executeVideoPromptJob(f.db, second.job.id, async () => { throw new Error("fixture provider failed"); }), /fixture provider failed/);
    assert.equal((await f.db("o_videoTrack").where({ id: f.firstTrack }).first()).prompt, "first result；灵兽说：我已知道");
    assert.equal((await f.db("o_videoTrack").where({ id: f.secondTrack }).first()).state, "生成失败");
  } finally { await f.destroy(); }
});

test("late prompt result preserves a human edit after CAS version advance", options, async () => {
  const f = await fixture();
  try {
    const prepared = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-cas-human", expectedVersion: 0 });
    let markStarted!: () => void;
    let releaseGeneration!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseGeneration = resolve; });
    const execution = executeVideoPromptJob(f.db, prepared.job.id, async () => {
      markStarted();
      await release;
      return "late model result；灵兽说：我已知道";
    });
    await started;
    const version = (await getCreativeState(f.db, "track", f.firstTrack, f.projectId)).version;
    await updateTrackPrompt(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, expectedVersion: version, prompt: "human edit", idempotencyKey: "prompt-human-edit" }, { kind: "human", id: "human:1" });
    const savedBeforeLateResult = await f.db("o_videoTrack").where({ id: f.firstTrack }).first();
    assert.equal(savedBeforeLateResult.state, "已完成");
    assert.equal(savedBeforeLateResult.reason, null);
    releaseGeneration();
    const result = await execution;
    assert.equal(result.state, "failed");
    const saved = await f.db("o_videoTrack").where({ id: f.firstTrack }).first();
    assert.equal(saved.prompt, "human edit");
    assert.equal(saved.state, "已完成");
    assert.equal(saved.reason, null);
    assert.equal((await f.db("ext_video_prompt_jobs").where({ id: prepared.job.id }).first()).resultPrompt, "late model result；灵兽说：我已知道");
    assert.match(String(result.reason), /人工修改/);
  } finally { await f.destroy(); }
});

test("late prompt result rejects an ordinary source storyboard edit even when track version is unchanged", options, async () => {
  const f = await fixture();
  try {
    const prepared = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-cas-source-edit", expectedVersion: 0 });
    await f.db("o_storyboard").where({ trackId: f.firstTrack }).update({ prompt: "source changed" });
    const result = await executeVideoPromptJob(f.db, prepared.job.id, async () => "late source result；灵兽说：我已知道");
    assert.equal(result.state, "failed");
    assert.equal((await f.db("o_videoTrack").where({ id: f.firstTrack }).first()).prompt, "");
    assert.match(String(result.reason), /源分镜/);
  } finally { await f.destroy(); }
});

test("preflight failure records an explicit failed receipt without replacing an existing prompt", options, async () => {
  const f = await fixture();
  try {
    const [trackId] = await insertRowsReturningIds(f.db, "o_videoTrack", { projectId: f.projectId, scriptId: f.scriptId, duration: 3, state: "已完成", prompt: "old prompt" });
    await assert.rejects(prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-preflight-fail", expectedVersion: 0 }), /没有可用于生成提示词/);
    await markVideoPromptPreparationFailed(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId }, "当前轨道没有可用于生成提示词的源分镜");
    const job = await f.db("ext_video_prompt_jobs").where({ projectId: f.projectId, scriptId: f.scriptId, trackId }).first();
    assert.equal(job.state, "failed");
    assert.equal((await f.db("o_videoTrack").where({ id: trackId }).first()).prompt, "old prompt");
    assert.equal((await f.db("o_videoTrack").where({ id: trackId }).first()).state, "已完成");
  } finally { await f.destroy(); }
});

test("all accepted batch tracks are durably queued before execution begins", options, async () => {
  const f = await fixture();
  try {
    const tracks: number[] = [];
    for (let index = 0; index < 18; index += 1) {
      const [trackId] = await insertRowsReturningIds(f.db, "o_videoTrack", { projectId: f.projectId, scriptId: f.scriptId, duration: 3, state: "未生成", prompt: "" });
      tracks.push(trackId);
      await f.db("o_storyboard").insert({ projectId: f.projectId, scriptId: f.scriptId, trackId, index: index + 10, duration: "3", prompt: `dialogue ${index}`, videoDesc: `shot ${index}` });
    }
    const jobs = await Promise.all(tracks.map((trackId) => prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId, model: "fixture:model", mode: "text", info: [], idempotencyKey: `prompt-batch-${trackId}`, expectedVersion: 0 })));
    assert.equal(jobs.length, 18);
    assert(jobs.every((item) => item.job.state === "queued"));
    assert.equal(await f.db("ext_video_prompt_jobs").where({ projectId: f.projectId, scriptId: f.scriptId }).whereIn("trackId", tracks).where("state", "queued").count("id as count").first().then((row) => Number(row?.count)), 18);
    assert.equal(await f.db("o_videoTrack").where({ projectId: f.projectId, scriptId: f.scriptId }).whereIn("id", tracks).where("state", "生成中").count("id as count").first().then((row) => Number(row?.count)), 18);
  } finally { await f.destroy(); }
});

import { preflightVideoPrompt, readCurrentVideoPromptReview, reviewGeneratedVideoPrompt, VideoPreflightError } from "../src/services/videoPromptReview";
import type { VideoPromptComposition } from "../src/services/videoPromptComposition";
const frozenComposition = (version = "v1"): VideoPromptComposition => ({ system: `generation-${version}`, reviewSystem: `review-${version}`, visualManual: "fixture style", versions: [{ key: "common.videoPromptGeneration", version }, { key: "review.videoPromptReview", version }], context: { model: "fixture:model", mode: "text", actualMode: "text", scriptDuration: 3, generation: { duration: 4, resolution: "480p", audio: false }, parameterSource: "用户本次选择", capabilities: { mode: ["text"], audio: "optional", durationResolutionMap: [{ duration: [4, 6], resolution: ["480p"] }] } } });

test("composition is frozen at preparation and replay never resolves edited or unavailable templates", options, async () => {
  const f = await fixture();
  try {
    let version = "v1", calls = 0;
    const input = { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], generation: { duration: 4, resolution: "480p", audio: false }, idempotencyKey: "snapshot-frozen-first", expectedVersion: 0 };
    const compose = async () => { calls += 1; return frozenComposition(version); };
    const first = await prepareVideoPromptJob(f.db, input, { compose });
    version = "v2";
    const replay = await prepareVideoPromptJob(f.db, input, { compose: async () => { throw new Error("edited template now unavailable"); } });
    assert.equal(replay.reused, true); assert.equal(replay.job.compositionSnapshot?.system, "generation-v1");
    await executeVideoPromptJob(f.db, first.job.id, async (job) => { assert.match(job.promptInput, /"duration":4/); assert.equal(job.compositionSnapshot?.reviewSystem, "review-v1"); return "灵兽说：我已知道"; });
    const next = await prepareVideoPromptJob(f.db, { ...input, idempotencyKey: "snapshot-frozen-next", expectedVersion: 1 }, { compose });
    assert.equal(next.job.compositionSnapshot?.system, "generation-v2"); assert.equal(calls, 2);
    await assert.rejects(prepareVideoPromptJob(f.db, { ...input, generation: { ...input.generation, duration: 6 } }), /不同请求/);
  } finally { await f.destroy(); }
});

test("failed semantic review stays durable, retries do not repeat the model call, and preflight never rewrites", options, async () => {
  const f = await fixture();
  try {
    const input = { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], generation: { duration: 4, resolution: "480p", audio: false }, idempotencyKey: "review-failure-durable", expectedVersion: 0 };
    const prepared = await prepareVideoPromptJob(f.db, input, { compose: async () => frozenComposition() });
    let generationCalls = 0, reviewCalls = 0;
    const generate = async (job: typeof prepared.job) => { generationCalls += 1; return reviewGeneratedVideoPrompt(job, "灵兽说：我已知道", async () => { reviewCalls += 1; throw new StructuredModelOutputError("MODEL_OUTPUT_LIMIT", { role: "universalAi", finishReason: "length", maxOutputTokens: 512, outputTokens: 512, textCharacters: 224 }); }); };
    const completed = await executeVideoPromptJob(f.db, prepared.job.id, generate);
    assert.equal(completed.state, "succeeded"); assert.equal(completed.promptReview?.status, "failed");
    await executeVideoPromptJob(f.db, prepared.job.id, generate);
    assert.equal(generationCalls, 1); assert.equal(reviewCalls, 1);
    const report = await preflightVideoPrompt(f.db, { ...input, prompt: completed.resultPrompt! });
    assert.equal(report.status, "failed"); assert.equal(reviewCalls, 1);
    assert.equal(report.failure?.code, "MODEL_OUTPUT_LIMIT");
    assert.equal(report.failure?.outputTokens, 512);
    const stored = await f.db("ext_video_prompt_jobs").where({ id: prepared.job.id }).first();
    assert.deepEqual(stored.reviewReport.failure, report.failure);
    assert.equal((await readCurrentVideoPromptReview(f.db, { ...input, prompt: completed.resultPrompt! }))?.status, "failed");
    assert.equal(await readCurrentVideoPromptReview(f.db, { ...input, prompt: "人工改词" }), null);
    assert.equal(await readCurrentVideoPromptReview(f.db, { ...input, prompt: completed.resultPrompt!, model: "fixture:other" }), null);
    assert.equal(await readCurrentVideoPromptReview(f.db, { ...input, prompt: completed.resultPrompt!, mode: "singleImage" }), null);
    assert.equal(await readCurrentVideoPromptReview(f.db, { ...input, prompt: completed.resultPrompt!, generation: { ...input.generation, duration: 6 } }), null);
    const human = "人工决定改成静默凝视";
    const warning = await preflightVideoPrompt(f.db, { ...input, prompt: human });
    assert.equal(warning.status, "issues"); assert(warning.findings.some((item) => item.code === "DIALOGUE_CHANGED"));
    assert.equal((await f.db("o_videoTrack").where({ id: f.firstTrack }).first()).prompt, "灵兽说：我已知道");
    await f.db("o_storyboard").where({ trackId: f.firstTrack }).update({ videoDesc: "source camera edited" });
    assert.equal(await readCurrentVideoPromptReview(f.db, { ...input, prompt: completed.resultPrompt! }), null);
    await assert.rejects(preflightVideoPrompt(f.db, { ...input, prompt: "@图片1 灵兽说：我已知道" }), (error:any) => error instanceof VideoPreflightError && error.report.findings.some(finding=>/未提供的标签/.test(finding.message)));
  } finally { await f.destroy(); }
});

test("a selected reference version change invalidates the saved review", options, async () => {
  const f = await fixture();
  try {
    const reference = await f.db("o_storyboard").where({ trackId: f.secondTrack }).first();
    const info = [{ id: Number(reference.id), sources: "storyboard" as const, fileType: "image" as const }];
    const input = { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "singleImage", info, generation: { duration: 4, resolution: "480p", audio: false }, idempotencyKey: "review-reference-version", expectedVersion: 0 };
    const composition = { ...frozenComposition(), context: { ...frozenComposition().context, mode: "singleImage", actualMode: "firstFrame" as const } };
    const prepared = await prepareVideoPromptJob(f.db, input, { compose: async () => composition });
    const report = { status: "passed" as const, findings: [], summary: "ok", revised: false, reviewedAt: Date.now() };
    const completed = await executeVideoPromptJob(f.db, prepared.job.id, async () => ({ prompt: "灵兽说：我已知道", review: report }));
    assert.equal((await readCurrentVideoPromptReview(f.db, { ...input, prompt: completed.resultPrompt! }))?.status, "passed");
    await f.db("ext_entity_state").insert({ entityType: "storyboard", entityId: Number(reference.id), projectId: f.projectId, version: 1, reviewState: "draft", locked: 0, updatedBy: "human:reference-edit", updatedAt: Date.now() }).onConflict(["entityType", "entityId"]).merge();
    assert.equal(await readCurrentVideoPromptReview(f.db, { ...input, prompt: completed.resultPrompt! }), null);
  } finally { await f.destroy(); }
});

test("video preflight reports the current selected image review boundary", options, async () => {
  const f = await fixture();
  try {
    await ensureImageReviewSchema(f.db);
    const reference = await f.db("o_storyboard").where({ trackId: f.secondTrack }).first();
    const report = await preflightVideoPrompt(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, prompt: "灵兽说：我已知道", model: "fixture:model", mode: "singleImage", generation: { duration: 4, resolution: "480p", audio: false }, info: [{ id: Number(reference.id), sources: "storyboard", fileType: "image" }] });
    assert(report.findings.some((finding) => finding.code === "IMAGE_REFERENCE_UNREVIEWED"));
    assert.match(report.summary, /检查/); assert.equal(report.preflight?.canSubmit,true);
  } finally { await f.destroy(); }
});

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { composeVideoPrompt } from "../src/services/videoPromptComposition";

test("real composition honors common overrides, relevant mode, explicit model mappings and rejects symlink escape", options, async () => {
  const f = await fixture();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-prompt-composition-"));
  try {
    const modelPromptDir = path.join(temp, "templates");
    await fs.mkdir(path.join(modelPromptDir, "video"), { recursive: true });
    await fs.writeFile(path.join(modelPromptDir, "video/textMode.md"), "TEXT-MODE-ONLY");
    await fs.writeFile(path.join(modelPromptDir, "video/firstFrameMode.md"), "FIRST-FRAME-ONLY");
    await fs.writeFile(path.join(modelPromptDir, "video/seedance2Multi-parameterMode.md"), "SEEDANCE-SUPPLEMENT");
    await fs.writeFile(path.join(modelPromptDir, "custom.md"), "EXPLICIT-MODEL-OVERRIDE");
    await f.db("o_prompt").where({ type: "videoPromptGeneration" }).update({ useData: "COMMON-CUSTOM-PRESERVED" });
    const input = { model: "fixture:seedance-2", mode: "text", referenceCount: 0, scriptDuration: 1.5, generation: { duration: 4, resolution: "480p", audio: false }, capabilities: { mode: ["text", "singleImage"], audio: "optional" as const, durationResolutionMap: [{ duration: [2, 4], resolution: ["480p"] }] } };
    const paths = { modelPromptDir, skillsDir: temp };
    const normal = await composeVideoPrompt(f.db, input, paths);
    assert.match(normal.system, /COMMON-CUSTOM-PRESERVED/); assert.match(normal.system, /TEXT-MODE-ONLY/); assert.match(normal.system, /SEEDANCE-SUPPLEMENT/); assert.doesNotMatch(normal.system, /FIRST-FRAME-ONLY/);
    const first = await composeVideoPrompt(f.db, { ...input, mode: "singleImage", referenceCount: 1 }, paths);
    assert.match(first.system, /FIRST-FRAME-ONLY/); assert.doesNotMatch(first.system, /TEXT-MODE-ONLY/);
    await f.db("ext_prompt_registry").insert({ key: "video.text", override: "TEXT-REGISTRY-EFFECTIVE", revision: 1, updatedAt: new Date().toISOString() }).onConflict("key").merge();
    await f.db("o_modelPrompt").insert({ vendorId: "fixture", model: "seedance-2", path: "video/textMode.md" });
    const registered = await composeVideoPrompt(f.db, input, paths);
    assert.equal(registered.system.match(/TEXT-REGISTRY-EFFECTIVE/g)?.length, 1);
    await f.db("o_modelPrompt").where({ vendorId: "fixture", model: "seedance-2" }).update({ path: "video/firstFrameMode.md" });
    await assert.rejects(composeVideoPrompt(f.db, input, paths), /与当前模式/);
    await f.db("o_modelPrompt").where({ vendorId: "fixture", model: "seedance-2" }).update({ path: "custom.md" });
    await fs.unlink(path.join(modelPromptDir, "video/seedance2Multi-parameterMode.md"));
    const mapped = await composeVideoPrompt(f.db, input, paths);
    assert.match(mapped.system, /EXPLICIT-MODEL-OVERRIDE/); assert.match(mapped.system, /COMMON-CUSTOM-PRESERVED/); assert.doesNotMatch(mapped.system, /SEEDANCE-SUPPLEMENT/);
    await fs.writeFile(path.join(temp, "outside.md"), "must not read outside template tree");
    await fs.symlink(path.join(temp, "outside.md"), path.join(modelPromptDir, "escape.md"));
    await f.db("o_modelPrompt").where({ vendorId: "fixture", model: "seedance-2" }).update({ path: "escape.md" });
    await assert.rejects(composeVideoPrompt(f.db, input, paths), /超出模板目录/);
  } finally { await f.destroy(); await fs.rm(temp, { recursive: true, force: true }); }
});

import {ensureRoleAudioWorkspaceSchema,saveRoleAudioBinding} from '../src/services/roleAudioWorkspace';
test('role voice casting reaches prompt snapshots and late binding changes cannot be adopted',options,async()=>{
 const f=await fixture();try{
  await ensureRoleAudioWorkspaceSchema(f.db);
  const [role]=await insertRowsReturningIds(f.db,'o_assets',{projectId:f.projectId,type:'role',name:'雪璃'});
  const [family]=await insertRowsReturningIds(f.db,'o_assets',{projectId:f.projectId,type:'audio',name:'雪璃声音'});
  const [clip]=await insertRowsReturningIds(f.db,'o_assets',{projectId:f.projectId,type:'audio',assetsId:family,name:'固定片段'});
  const [media]=await insertRowsReturningIds(f.db,'o_image',{assetsId:clip,type:'audio',state:'已完成',filePath:'/voice.mp3'});
  await f.db('o_assets').where({id:clip}).update({imageId:media});
  const board=await f.db('o_storyboard').where({trackId:f.secondTrack}).first();await f.db('o_assets2Storyboard').insert({assetId:role,storyboardId:board.id});
  await saveRoleAudioBinding(f.db,{projectId:f.projectId,roleAssetId:role,expectedVersion:0,audioIds:[clip],audioVersions:[{id:clip,expectedVersion:0}],idempotencyKey:'cast-test-bind'}, {id:'human:1',kind:'human'});
  const prepared=await prepareVideoPromptJob(f.db,{projectId:f.projectId,scriptId:f.scriptId,trackId:f.secondTrack,expectedVersion:0,idempotencyKey:'cast-test-prompt',model:'fixture:seedance-2',mode:JSON.stringify(['imageReference:9','audioReference:3']),info:[{id:board.id,sources:'storyboard',fileType:'image'},{id:clip,sources:'assets',fileType:'audio'}]});
  assert.match(prepared.job.promptInput,/固定音色参考对应角色：雪璃/);assert.match(prepared.job.promptInput,/@音频1/);
  const completed=await executeVideoPromptJob(f.db,prepared.job.id,async()=>{
    await saveRoleAudioBinding(f.db,{projectId:f.projectId,roleAssetId:role,expectedVersion:1,audioIds:[],audioVersions:[],idempotencyKey:'cast-test-clear'}, {id:'human:1',kind:'human'});
    return '雪璃转身，音色参考@音频1';
  });
  assert.equal(completed.state,'failed');assert.equal((await f.db('o_videoTrack').where({id:f.secondTrack}).first()).prompt,'');
 }finally{await f.destroy();}
});

test('official Seedance policy is included even with explicit model prompt mapping',options,async()=>{
 const f=await fixture();try{
  await f.db('o_modelPrompt').insert({vendorId:'volcengineSd2',model:'doubao-seedance-2-0-mini-260615',path:'video/textMode.md'});
  const value=await composeVideoPrompt(f.db,{model:'volcengineSd2:doubao-seedance-2-0-mini-260615',mode:'text',referenceCount:0,scriptDuration:4,generation:{duration:4,resolution:'480p',audio:true},capabilities:{mode:['text'],audio:'optional',durationResolutionMap:[{duration:[4],resolution:['480p']}]}},{skillsDir:path.resolve('data/skills'),modelPromptDir:path.resolve('data/modelPrompt')});
  assert.ok(value.versions.some(x=>x.key==='video.volcengineOfficial'));assert.match(value.system,/generate_audio 仅控制/);assert.match(value.system,/未实际上传音频/);
 }finally{await f.destroy();}
});
