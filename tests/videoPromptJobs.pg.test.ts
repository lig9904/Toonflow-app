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
    { projectId, scriptId, trackId: secondTrack, index: 0, duration: "4", prompt: "雪璃转身", videoDesc: "海岸远景" },
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
    await executeVideoPromptJob(f.db, prepared.job.id, async () => { calls += 1; return "saved once"; });
    const retry = await prepareVideoPromptJob(f.db, input);
    assert.equal(retry.reused, true);
    const result = await executeVideoPromptJob(f.db, retry.job.id, async () => { calls += 1; return "duplicate"; });
    assert.equal(result.resultPrompt, "saved once");
    assert.equal(calls, 1);
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
      executeVideoPromptJob(f.db, first.job.id, async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return "first result"; }),
      executeVideoPromptJob(f.db, first.job.id, async () => { calls += 1; return "duplicate result"; }),
    ]);
    assert.equal(firstRun[0].resultPrompt, "first result");
    assert.equal(firstRun[1].resultPrompt, "first result");
    assert.equal(calls, 1);
    await assert.rejects(executeVideoPromptJob(f.db, second.job.id, async () => { throw new Error("fixture provider failed"); }), /fixture provider failed/);
    assert.equal((await f.db("o_videoTrack").where({ id: f.firstTrack }).first()).prompt, "first result");
    assert.equal((await f.db("o_videoTrack").where({ id: f.secondTrack }).first()).state, "生成失败");
  } finally { await f.destroy(); }
});

test("late prompt result preserves a human edit after CAS version advance", options, async () => {
  const f = await fixture();
  try {
    const prepared = await prepareVideoPromptJob(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, model: "fixture:model", mode: "text", info: [], idempotencyKey: "prompt-cas-human" });
    const version = (await getCreativeState(f.db, "track", f.firstTrack, f.projectId)).version;
    await updateTrackPrompt(f.db, { projectId: f.projectId, scriptId: f.scriptId, trackId: f.firstTrack, expectedVersion: version, prompt: "human edit", idempotencyKey: "prompt-human-edit" }, { kind: "human", id: "human:1" });
    const result = await executeVideoPromptJob(f.db, prepared.job.id, async () => "late model result");
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
    const result = await executeVideoPromptJob(f.db, prepared.job.id, async () => "late source result");
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
