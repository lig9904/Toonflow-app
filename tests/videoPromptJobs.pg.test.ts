import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureTrackWorkspaceSchema, updateTrackPrompt } from "../src/services/trackWorkspace";
import { getCreativeState } from "../src/services/creativeWorkspace";
import { executeVideoPromptJob, markVideoPromptPreparationFailed, prepareVideoPromptJob, ensureVideoPromptJobSchema } from "../src/services/videoPromptJobs";

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

test("empty visual info still uses each track's complete source storyboard", options, async () => {
  const f = await fixture();
  try {
    const first = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-source-first" });
    const second = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.secondTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-source-second" });
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
    const input = { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-completed-retry" };
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

test("the current track prompt remains authoritative after a successful job is manually edited", options, async () => {
  const f = await fixture();
  try {
    const input = { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-authoritative-current" };
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
    const accepted = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "singleImage", info: [{ id: Number(otherStoryboard.id), sources: "storyboard", fileType: "image" }], idempotencyKey: "prompt-cross-track-ref" });
    assert.match(accepted.job.promptInput, new RegExp(String(otherStoryboard.id)));
    const [otherProject] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Other" });
    const [foreignAsset] = await insertRowsReturningIds(f.db, "o_assets", { projectId: otherProject, name: "foreign", type: "role" });
    await assert.rejects(prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [{ id: foreignAsset, sources: "assets" }], idempotencyKey: "prompt-foreign-ref" }), /不属于当前项目/);
  } finally { await f.destroy(); }
});

test("track prompt jobs save independently, isolate failures, and deduplicate concurrent retries", options, async () => {
  const f = await fixture();
  try {
    const first = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-independent-first" });
    const second = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.secondTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-independent-second" });
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
    const prepared = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-cas-human" });
    const version = (await getCreativeState(f.db, "track", f.firstTrack, f.projectId)).version;
    await updateTrackPrompt(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, expectedVersion: version, prompt: "human edit", idempotencyKey: "prompt-human-edit" }, { kind: "human", id: "human:1" });
    const result = await executeVideoPromptJob(f.db, prepared.job.id, async () => "late model result；灵兽说：我已知道");
    assert.equal(result.state, "failed");
    assert.equal((await f.db("o_videoTrack").where({ id: f.firstTrack }).first()).prompt, "human edit");
    assert.match(String(result.reason), /人工修改/);
  } finally { await f.destroy(); }
});

test("late prompt result rejects an ordinary source storyboard edit even when track version is unchanged", options, async () => {
  const f = await fixture();
  try {
    const prepared = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-cas-source-edit" });
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
    await assert.rejects(prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-preflight-fail" }), /没有可用于生成提示词/);
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
    const jobs = await Promise.all(tracks.map((trackId) => prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId, model: "fixture:model", mode: "text", info: [], idempotencyKey: `prompt-batch-${trackId}` })));
    assert.equal(jobs.length, 18);
    assert(jobs.every((item) => item.job.state === "queued"));
    assert.equal(await f.db("ext_video_prompt_jobs").where({ projectId: f.projectId, scriptId: f.scriptId }).whereIn("trackId", tracks).where("state", "queued").count("id as count").first().then((row) => Number(row?.count)), 18);
    assert.equal(await f.db("o_videoTrack").where({ projectId: f.projectId, scriptId: f.scriptId }).whereIn("id", tracks).where("state", "生成中").count("id as count").first().then((row) => Number(row?.count)), 18);
  } finally { await f.destroy(); }
});

import { preflightVideoPrompt, readCurrentVideoPromptReview, reviewGeneratedVideoPrompt } from "../src/services/videoPromptReview";
import type { VideoPromptComposition } from "../src/services/videoPromptComposition";
const frozenComposition = (version = "v1"): VideoPromptComposition => ({ system: `generation-${version}`, reviewSystem: `review-${version}`, visualManual: "fixture style", versions: [{ key: "common.videoPromptGeneration", version }, { key: "review.videoPromptReview", version }], context: { model: "fixture:model", mode: "text", actualMode: "text", scriptDuration: 3, generation: { duration: 4, resolution: "480p", audio: false }, parameterSource: "用户本次选择", capabilities: { mode: ["text"], audio: "optional", durationResolutionMap: [{ duration: [4, 6], resolution: ["480p"] }] } } });

test("composition is frozen at preparation and replay never resolves edited or unavailable templates", options, async () => {
  const f = await fixture();
  try {
    let version = "v1", calls = 0;
    const input = { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], generation: { duration: 4, resolution: "480p", audio: false }, idempotencyKey: "snapshot-frozen-first" };
    const compose = async () => { calls += 1; return frozenComposition(version); };
    const first = await prepareVideoPromptJob(f.db, input, { compose });
    version = "v2";
    const replay = await prepareVideoPromptJob(f.db, input, { compose: async () => { throw new Error("edited template now unavailable"); } });
    assert.equal(replay.reused, true); assert.equal(replay.job.compositionSnapshot?.system, "generation-v1");
    await executeVideoPromptJob(f.db, first.job.id, async (job) => { assert.match(job.promptInput, /"duration":4/); assert.equal(job.compositionSnapshot?.reviewSystem, "review-v1"); return "灵兽说：我已知道"; });
    const next = await prepareVideoPromptJob(f.db, { ...input, idempotencyKey: "snapshot-frozen-next" }, { compose });
    assert.equal(next.job.compositionSnapshot?.system, "generation-v2"); assert.equal(calls, 2);
    await assert.rejects(prepareVideoPromptJob(f.db, { ...input, generation: { ...input.generation, duration: 6 } }), /不同请求/);
  } finally { await f.destroy(); }
});

test("failed semantic review stays durable, retries do not repeat the model call, and preflight never rewrites", options, async () => {
  const f = await fixture();
  try {
    const input = { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], generation: { duration: 4, resolution: "480p", audio: false }, idempotencyKey: "review-failure-durable" };
    const prepared = await prepareVideoPromptJob(f.db, input, { compose: async () => frozenComposition() });
    let generationCalls = 0, reviewCalls = 0;
    const generate = async (job: typeof prepared.job) => { generationCalls += 1; return reviewGeneratedVideoPrompt(job, "灵兽说：我已知道", async () => { reviewCalls += 1; throw new Error("fixture timeout"); }); };
    const completed = await executeVideoPromptJob(f.db, prepared.job.id, generate);
    assert.equal(completed.state, "succeeded"); assert.equal(completed.promptReview?.status, "failed");
    await executeVideoPromptJob(f.db, prepared.job.id, generate);
    assert.equal(generationCalls, 1); assert.equal(reviewCalls, 1);
    const report = await preflightVideoPrompt(f.db, { ...input, prompt: completed.resultPrompt! });
    assert.equal(report.status, "failed"); assert.equal(reviewCalls, 1);
    assert.equal((await readCurrentVideoPromptReview(f.db, { ...input, prompt: completed.resultPrompt! }))?.status, "failed");
    assert.equal(await readCurrentVideoPromptReview(f.db, { ...input, prompt: "人工改词" }), null);
    assert.equal(await readCurrentVideoPromptReview(f.db, { ...input, prompt: completed.resultPrompt!, generation: { ...input.generation, duration: 6 } }), null);
    const human = "人工决定改成静默凝视";
    const warning = await preflightVideoPrompt(f.db, { ...input, prompt: human });
    assert.equal(warning.status, "issues"); assert(warning.findings.some((item) => item.code === "DIALOGUE_CHANGED"));
    assert.equal((await f.db("o_videoTrack").where({ id: f.firstTrack }).first()).prompt, "灵兽说：我已知道");
    await f.db("o_storyboard").where({ trackId: f.firstTrack }).update({ videoDesc: "source camera edited" });
    assert.equal(await readCurrentVideoPromptReview(f.db, { ...input, prompt: completed.resultPrompt! }), null);
    await assert.rejects(preflightVideoPrompt(f.db, { ...input, prompt: "@图片1 灵兽说：我已知道" }), /未提供的标签/);
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
    await f.db("o_modelPrompt").insert({ vendorId: "fixture", model: "seedance-2", path: "custom.md" });
    await fs.unlink(path.join(modelPromptDir, "video/seedance2Multi-parameterMode.md"));
    const mapped = await composeVideoPrompt(f.db, input, paths);
    assert.match(mapped.system, /EXPLICIT-MODEL-OVERRIDE/); assert.match(mapped.system, /COMMON-CUSTOM-PRESERVED/); assert.doesNotMatch(mapped.system, /SEEDANCE-SUPPLEMENT/);
    await fs.writeFile(path.join(temp, "outside.md"), "must not read outside template tree");
    await fs.symlink(path.join(temp, "outside.md"), path.join(modelPromptDir, "escape.md"));
    await f.db("o_modelPrompt").where({ vendorId: "fixture", model: "seedance-2" }).update({ path: "escape.md" });
    await assert.rejects(composeVideoPrompt(f.db, input, paths), /超出模板目录/);
  } finally { await f.destroy(); await fs.rm(temp, { recursive: true, force: true }); }
});
