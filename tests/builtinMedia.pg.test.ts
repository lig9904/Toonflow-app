import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureProductionStateSchema } from "../src/services/productionState";
import { ensureBuiltinAgentRuntimeSchema, BuiltinAgentRuntime } from "../src/services/builtinAgentRuntime";
import { createImageGenerationService, ensureProductionImageJobSchema } from "../src/services/imageJobs/runtime";
import { VideoJobService, ensureVideoJobsSchema } from "../src/services/videoJobs";
import { createProductionAgentExecutor } from "../src/services/builtinAgent/productionExecutor";
import { createProductionMediaCapabilities, validateVideoParameters, defaultVideoSettings } from "../src/services/builtinAgent/media";
import { defaultBuiltinRunLimits } from "../src/services/builtinAgent/contracts";
import type { StructuredScriptModel } from "../src/services/builtinAgent/scriptExecutor";
import { ensureCreativeWorkspaceSchema } from "../src/services/creativeWorkspace";

import { prepareVideoPromptForGeneration } from "../src/services/videoPromptCompositionService";
import { prepareVideoPromptJob } from "../src/services/videoPromptJobs";
const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureProductionStateSchema(f.db);
  await ensureBuiltinAgentRuntimeSchema(f.db);
  await ensureCreativeWorkspaceSchema(f.db);
  await ensureProductionImageJobSchema(f.db);
  await ensureVideoJobsSchema(f.db);
  await f.db.schema.createTable("team_users", (table) => { table.integer("user_id").primary(); table.boolean("enabled"); table.text("role"); });
  await f.db("team_users").insert({ user_id: 1, enabled: true, role: "editor" });
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Media runtime", imageModel: "mock:image", videoModel: "mock:video", imageQuality: "1K", videoRatio: "16:9", mode: "endFrameOptional" });
  const [scriptId] = await insertRowsReturningIds(f.db, "o_script", { projectId, name: "Episode", content: "Scene" });
  const [trackId] = await insertRowsReturningIds(f.db, "o_videoTrack", { projectId, scriptId, duration: 5, prompt: "人工保存：Wind moves the trees，保持逆光。" });
  const [storyboardId] = await insertRowsReturningIds(f.db, "o_storyboard", { projectId, scriptId, trackId, index: 0, prompt: "A landscape", videoDesc: "Wind moves the trees", duration: "5", shouldGenerateImage: 1, state: "未生成" });
  return { ...f, projectId, scriptId, trackId, storyboardId };
}
const videoModel = { type: "video", mode: ["endFrameOptional"], audio: "optional" as const, durationResolutionMap: [{ duration: [4, 5], resolution: ["480p", "720p"] }] };

for (const withSavedPrompt of [true,false]) test(`production runtime creates image then video using ${withSavedPrompt ? "saved human" : "shared generated"} prompt with counted hooks`, options, async () => {
  const f = await fixture();
  if(!withSavedPrompt)await f.db("o_videoTrack").where({id:f.trackId}).update({prompt:null});
  let promptCalls=0,reviewCalls=0;
  const saved: string[] = [];
  const imagesSubmitted: any[] = [], videosSubmitted: any[] = [];
  const imageProvider = { fingerprint: "image-fixture", submit: async (config: unknown) => { imagesSubmitted.push(config); return { taskId: "image-task" }; }, query: async () => ({ status: "succeeded" as const, outputUrl: "https://fixture.invalid/image.png" }) };
  const videoProvider = { fingerprint: "video-fixture", submit: async (config: unknown) => { videosSubmitted.push(config); return { taskId: "video-task" }; }, query: async () => ({ status: "succeeded" as const, outputUrl: "https://fixture.invalid/video.mp4" }) };
  const images = createImageGenerationService({ db: f.db, providerFor: async () => imageProvider, download: async (_, path) => { saved.push(path); }, pollMs: 10 });
  const videos = new VideoJobService(f.db, { providerFor: async () => videoProvider, download: async (_, path) => { saved.push(path); }, schedule: false, initialPollDelayMs: 10 });
  try {
    let reviewSource: any;
    const model: StructuredScriptModel = { async generate(input) {
      const value = input.role === "productionAgent:decisionAgent" ? { actions: ["generateImages", "generateVideos", "review"], assetIds: [], storyboardIds: [f.storyboardId], question: null, summary: "Generate the selected shot" } : { findings: [], summary: "Done" };
      if (input.role === "productionAgent:supervisionAgent") reviewSource = input.input;
      return { value: input.schema.parse(value), outputTokens: 5 };
    } };
    const media = createProductionMediaCapabilities({ db: f.db, images, videos,
      prepareVideoPrompt: (input,hooks)=>prepareVideoPromptForGeneration(f.db,input,{prepare: value=>prepareVideoPromptJob(f.db,value),generateDraft:async()=>{promptCalls++;return "统一生成：Wind moves the trees，保持逆光。";},reviewDraft:async(_job,draft)=>{reviewCalls++;return {prompt:draft,review:{status:"passed",findings:[],summary:"fixture",revised:false,reviewedAt:Date.now()}};}},hooks), imageModelFor: async (key) => ({ key, modelName: key.split(/:(.+)/)[1], type: "image", mode: ["text"] }), modelFor: async (_, type) => type === "video" ? videoModel : { type: "image", mode: ["text"] }, videoProviderFor: async () => videoProvider, toBase64: async (path) => { assert(saved.includes(path)); return `data:image/png;base64,${Buffer.from(path).toString("base64")}`; }, pollMs: 20 });
    const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async () => undefined, execute: createProductionAgentExecutor({ db: f.db, model, media, loadSkill: async () => "fixture", videoModelMetadata: async () => defaultVideoSettings(videoModel) }) });
    const created = await runtime.create({ agentType: "productionAgent", projectId: f.projectId, scriptId: f.scriptId, requestedBy: 1, prompt: "generate", idempotencyKey: "production-media-full", limits: { ...defaultBuiltinRunLimits, maxImageGenerations: 1, maxVideoGenerations: 1 } });
    await runtime.runOnce();
    const run = await runtime.get(created.run.id);
    assert.equal(run.status, "succeeded", run.errorMessage ?? "");
    assert.equal(imagesSubmitted.length, 1); assert.equal(videosSubmitted.length, 1);
    assert.match(videosSubmitted[0].prompt,withSavedPrompt?/人工保存：Wind moves the trees，保持逆光。/:/统一生成：Wind moves the trees，保持逆光。/);
    assert.equal(promptCalls,withSavedPrompt?0:1);assert.equal(reviewCalls,withSavedPrompt?0:1);
    assert.equal(run.modelCalls,withSavedPrompt?2:4);
    assert.equal(videosSubmitted[0].referenceList.length, 1); assert.equal(videosSubmitted[0].audio, false); assert.equal(videosSubmitted[0].resolution, "480p");
    const board = await f.db("o_storyboard").where({ id: f.storyboardId }).first();
    assert.equal(reviewSource.flow.storyboard[0].src, board.filePath);
    const video = await f.db("o_video").where({ videoTrackId: f.trackId }).first();
    assert.equal(video.state, "生成成功");
    assert.equal((await f.db("o_videoTrack").where({ id: f.trackId }).first()).videoId, null);
    assert.equal((await runtime.events(run.id)).filter((event) => event.type === "media.reserved").length, 2);
    assert.equal((await f.db("ext_builtin_runs").where({ id: run.id }).first()).imageGenerations, 1);
    assert.equal((await f.db("ext_builtin_runs").where({ id: run.id }).first()).videoGenerations, 1);
  } finally { images.stop(); videos.stop(); await f.destroy(); }
});

test("unsupported video combinations fail before a provider submission", () => {
  assert.deepEqual(defaultVideoSettings(videoModel), { mode: "endFrameOptional", resolution: "480p", audio: false });
  assert.throws(() => validateVideoParameters(videoModel, { mode: "text", duration: 5, resolution: "480p" }), /模式/);
  assert.throws(() => validateVideoParameters(videoModel, { mode: "endFrameOptional", duration: 6, resolution: "480p" }), /时长/);
  assert.throws(() => validateVideoParameters({ ...videoModel, audio: false }, { mode: "endFrameOptional", duration: 5, resolution: "480p", audio: true }), /音频/);
});

test("interrupted media step resumes its durable job without consuming another generation allowance", options, async () => {
  const f = await createPostgresFixture();
  await ensureBuiltinAgentRuntimeSchema(f.db);
  let resumed = false;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let planningCalls = 0;
  const execute = async (ctx: any) => {
    const snapshot = await ctx.step("input-snapshot", {}, async () => ({ id: 1, optionalSetting: undefined, createdAt: new Date("2026-01-01T00:00:00Z") }));
    await ctx.step("saved-plan", { snapshot, defaultSetting: undefined }, async () => { planningCalls++; return "plan"; }, { modelCall: true });
    return ctx.step("same-media", { generationKey: "durable-one" }, async () => { if (!resumed) { entered(); await blocked; } return { jobId: 1, status: "succeeded" }; }, { imageGeneration: true });
  };
  const runtime = new BuiltinAgentRuntime({ db: f.db, execute, authorize: async () => undefined });
  try {
    const created = await runtime.create({ agentType: "productionAgent", projectId: 1, requestedBy: 1, prompt: "image", idempotencyKey: "interrupted-image-budget", limits: { ...defaultBuiltinRunLimits, maxImageGenerations: 1 } });
    const running = runtime.runOnce();
    await waiting;
    const current = await runtime.get(created.run.id);
    const paused = await runtime.control(current.id, current.version, "pause", "pause");
    release(); await running;
    resumed = true;
    await runtime.control(current.id, paused.version, "resume", "continue");
    await runtime.runOnce();
    const done = await runtime.get(current.id);
    assert.equal(done.status, "succeeded", done.errorMessage ?? "");
    assert.equal((await f.db("ext_builtin_runs").where({ id: done.id }).first()).imageGenerations, 1);
    assert.equal(planningCalls, 1, "JSON checkpoint replay must not rerun completed planning");
    assert.equal(Number((await f.db("ext_builtin_run_steps").where({ runId: done.id, stepKey: "same-media" }).first()).attempt), 2);
  } finally { release?.(); await runtime.stop(); await f.destroy(); }
});
