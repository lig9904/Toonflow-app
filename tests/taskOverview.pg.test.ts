import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { ensureTeamSchema, TeamService } from "../src/services/team";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { getTaskProjectOptions, readProjectStatistics, readTaskCategories, readTaskDetail, readTaskList } from "../src/services/taskOverview";
import { BuiltinAgentRuntime, ensureBuiltinAgentRuntimeSchema } from "../src/services/builtinAgentRuntime";
import { ensureProductionImageJobSchema } from "../src/services/imageJobs/runtime";
import { ensureVideoJobsSchema } from "../src/services/videoJobs";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
test("task joins preserve task identity and all filters stay within shared projects", options, async () => {
  const f = await createPostgresFixture();
  try {
    await migratePostgresFixture(f.db);
    await ensureTeamSchema(f.db, { bootstrapAdminUserId: 1 });
    const viewer = await new TeamService(f.db).createUser(1, { name: "viewer", password: "task-fixture-password", role: "viewer" });
    const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Same label" });
    const [second] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Same label" });
    const [foreign] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Foreign" });
    await f.db("team_projects").where({ project_id: foreign }).update({ team_key: "foreign" });
    await f.db("o_tasks").insert([
      { id: 501, projectId, taskClass: "图像", state: "已完成", describe: "first" },
      { id: 502, projectId: second, taskClass: "视频", state: "生成中", describe: "second" },
      { id: 503, projectId: foreign, taskClass: "Private category", state: "已完成", describe: "foreign" },
    ]);
    const projects = await getTaskProjectOptions(f.db, viewer.id);
    assert.deepEqual(projects.map((p) => p.id), [projectId, second], "same-name projects retain separate IDs and SQL is PG-valid");
    const all = await readTaskList(f.db, viewer.id, { page: 1, limit: 10 });
    assert.equal(all.total, 2);
    assert.deepEqual(all.data.map((r) => r.id), ["legacy:502", "legacy:501"], "project join must not replace task id and source prefixes prevent collisions");
    const filtered = await readTaskList(f.db, viewer.id, { projectId, state: "已完成", taskClass: "图像", page: 1, limit: 10 });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.data[0].projectName, "Same label");
    assert.equal((await readTaskDetail(f.db, viewer.id, 501)).id, "legacy:501");
    await assert.rejects(readTaskDetail(f.db, viewer.id, 503));
    await assert.rejects(readTaskList(f.db, viewer.id, { projectId: foreign, page: 1, limit: 10 }));
    assert.deepEqual((await readTaskCategories(f.db, viewer.id)).map((c) => c.taskClass).sort(), ["图像", "视频"].sort());
  } finally { await f.destroy(); }
});

test("task overview merges builtin, image, video, and legacy rows from durable state without duplicate projections", options, async () => {
  const f = await createPostgresFixture();
  let runtime: BuiltinAgentRuntime | undefined;
  try {
    await migratePostgresFixture(f.db);
    await ensureTeamSchema(f.db, { bootstrapAdminUserId: 1 });
    const team = new TeamService(f.db);
    const viewer = await team.createUser(1, { name: "overview-viewer", password: "task-overview-password", role: "viewer" });
    const editorA = await team.createUser(1, { name: "overview-editor-a", password: "task-overview-password", role: "editor" });
    const editorB = await team.createUser(1, { name: "overview-editor-b", password: "task-overview-password", role: "editor" });
    const viewerB = await team.createUser(1, { name: "overview-viewer-b", password: "task-overview-password", role: "viewer" });
    const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Unified tasks" });
    const [foreignProject] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Private tasks" });
    await f.db("team_projects").where({ project_id: foreignProject }).update({ team_key: "private" });
    await ensureBuiltinAgentRuntimeSchema(f.db);
    await ensureProductionImageJobSchema(f.db);
    await ensureVideoJobsSchema(f.db);

    runtime = new BuiltinAgentRuntime({ db: f.db, execute: async () => null, authorize: async () => undefined, workerId: "task-overview-runtime" });
    const { run } = await runtime.create({ agentType: "productionAgent", projectId, scriptId: 91, requestedBy: 1, prompt: "Build a durable scene", idempotencyKey: "overview-builtin-run", limits: { maxModelCalls: 3, maxToolSteps: 8, maxOutputTokens: 1000, maxImageGenerations: 1, maxVideoGenerations: 1 } });
    const { run: foreignRun } = await runtime.create({ agentType: "scriptAgent", projectId: foreignProject, requestedBy: 1, prompt: "private", idempotencyKey: "overview-private-run", limits: { maxModelCalls: 1, maxToolSteps: 1, maxOutputTokens: 10, maxImageGenerations: 0, maxVideoGenerations: 0 } });
    await f.db("ext_builtin_runs").where({ id: run.id }).update({ status: "waiting_human", toolSteps: 3, currentStep: "review", waitingQuestion: "Choose a style", updatedAt: 2000 });

    const [imageJob] = await f.db("ext_image_jobs").insert({
      idempotencyKey: `builtin:${run.id}:image:asset:7`, payloadHash: "image-hash", modelKey: "image-model", projectId,
      outputPath: `/${projectId}/assets/final.png`, payload: JSON.stringify({ projectId, modelKey: "image-model", providerFingerprint: "fixture", outputPath: `/${projectId}/assets/final.png`, config: { prompt: "portrait" } }),
      upstreamTaskId: "image-task", resultUrl: "https://fixture/image", status: "SUCCEEDED", pollAttempts: 2, queryFailures: 0, downloadFailures: 0, createdAt: 1200, updatedAt: 1800,
    }).returning("id");
    await f.db("ext_image_job_bindings").insert({
      jobId: imageJob.id, projectId, scriptId: 91, targetKind: "asset", targetId: "7", expectedVersion: 0,
      targetSignature: "target", runId: run.id, runInputRevision: 0, artifactPath: `/${projectId}/assets/final.png`, selected: false,
      state: "SUCCEEDED", createdAt: 1200, updatedAt: 1800,
    });

    const [videoJob] = await f.db("ext_video_jobs").insert({
      idempotencyKey: `builtin:${run.id}:video:track:33`, payloadHash: "video-hash", modelKey: "video-model", projectId, scriptId: 91, trackId: 33, videoId: 44,
      outputPath: `/${projectId}/video/final.mp4`, payload: JSON.stringify({ modelKey: "video-model", providerFingerprint: "fixture", projectId, scriptId: 91, trackId: 33, videoId: 44, outputPath: `/${projectId}/video/final.mp4`, config: { prompt: "motion" } }),
      upstreamTaskId: "video-task", status: "FAILED", pollAttempts: 4, queryFailures: 1, downloadFailures: 0, lastError: "provider rejected", createdAt: 1300, updatedAt: 1900,
    }).returning("id");
    await f.db("ext_builtin_run_events").insert([
      { runId: run.id, sequence: 2, type: "media.reserved", data: JSON.stringify({ kind: "video", jobId: Number(videoJob.id), videoId: 44, trackId: 33 }), createdAt: 1300 },
      { runId: run.id, sequence: 3, type: "artifact.saved", data: JSON.stringify({ kind: "image", jobId: Number(imageJob.id), path: `/${projectId}/assets/final.png`, targetKind: "asset", targetId: 7, selected: false }), createdAt: 1800 },
    ]);
    await f.db("o_tasks").insert([
      { id: 601, projectId, taskClass: "旧流程", state: "已完成", describe: "real legacy", startTime: 1100 },
      { id: 602, projectId, taskClass: "图像生成", state: "已完成", describe: "explicit projection", relatedObjects: JSON.stringify({ sourceTaskId: `image:${Number(imageJob.id)}` }), startTime: 1800 },
      { id: 603, projectId: foreignProject, taskClass: "私有", state: "进行中", describe: "hidden", startTime: 3000 },
    ]);

    const all = await readTaskList(f.db, viewer.id, { projectId, page: 1, limit: 20 });
    assert.equal(all.total, 4, "explicit legacy projection is not counted beside its durable image job");
    assert.deepEqual(new Set(all.data.map((task) => task.id)), new Set([`legacy:601`, `builtin:${run.id}`, `image:${Number(imageJob.id)}`, `video:${Number(videoJob.id)}`]));
    assert.equal(all.data.find((task) => task.source === "builtin")?.state, "待人工");
    assert.equal(all.data.find((task) => task.source === "image")?.artifacts[0]?.path, `/${projectId}/assets/final.png`);
    assert.equal(all.data.find((task) => task.source === "video")?.reason, "provider rejected");
    assert.equal(all.data.find((task) => task.source === "video")?.parentTaskId, `builtin:${run.id}`);
    assert.equal((await readTaskList(f.db, viewer.id, { projectId, state: "待人工", page: 1, limit: 20 })).total, 1);
    assert.equal((await readTaskList(f.db, viewer.id, { projectId, source: "image", taskClass: "图像生成", page: 1, limit: 20 })).total, 1);
    for (const memberId of [1, viewer.id, editorA.id, editorB.id, viewerB.id]) {
      const visible = await readTaskList(f.db, memberId, { page: 1, limit: 20 });
      assert.equal(visible.total, 4, `shared team member ${memberId} must see the same authorized task snapshot`);
    }
    assert.deepEqual((await readTaskCategories(f.db, viewer.id)).map((row) => row.taskClass).sort(), ["内置 Agent", "图像生成", "旧流程", "视频生成"].sort());

    const detail = await readTaskDetail(f.db, viewer.id, `builtin:${run.id}`);
    assert.equal(detail.waitingQuestion, "Choose a style");
    assert.equal(detail.events.length, 2);
    assert.deepEqual(detail.relatedTasks.map((task) => task.source).sort(), ["image", "video"]);
    await assert.rejects(readTaskDetail(f.db, viewer.id, "legacy:603"));
    await assert.rejects(readTaskDetail(f.db, viewer.id, `builtin:${foreignRun.id}`));
  } finally {
    if (runtime) await runtime.stop();
    await f.destroy();
  }
});

test("project statistics count real storyboard entities rather than legacy asset placeholders", options, async () => {
  const f = await createPostgresFixture();
  try {
    await migratePostgresFixture(f.db);
    await ensureTeamSchema(f.db, { bootstrapAdminUserId: 1 });
    const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Statistics" });
    const [scriptId] = await insertRowsReturningIds(f.db, "o_script", { projectId, name: "Episode" });
    const [assetId] = await insertRowsReturningIds(f.db, "o_assets", { projectId, type: "role", name: "Hero" });
    await f.db("o_assets").insert([{ projectId, type: "role", name: "Costume", assetsId: assetId }, { projectId, scriptId, type: "分镜", name: "Legacy placeholder" }]);
    await f.db("o_storyboard").insert([{ projectId, scriptId, prompt: "A" }, { projectId, scriptId, prompt: "B" }]);
    const stats = await readProjectStatistics(f.db, 1, projectId);
    assert.deepEqual(stats, { roleCount: 1, scriptCount: 1, videoCount: 0, storyboardCount: 2 });
  } finally { await f.destroy(); }
});
