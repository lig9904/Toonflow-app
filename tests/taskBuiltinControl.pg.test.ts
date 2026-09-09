import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { ensureTeamSchema, TeamService } from "../src/services/team";
import { BuiltinAgentRuntime, ensureBuiltinAgentRuntimeSchema } from "../src/services/builtinAgentRuntime";
import { builtinTaskControlMetadata, readTaskDetail, readTaskList } from "../src/services/taskOverview";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };

test("builtin task control metadata exposes only state-valid actions and treats limits as ceilings", () => {
  assert.deepEqual(builtinTaskControlMetadata({ id: "run", version: 1, status: "queued" }).allowedActions, ["pause", "cancel", "takeover"]);
  assert.deepEqual(builtinTaskControlMetadata({ id: "run", version: 2, status: "running" }).allowedActions, ["pause", "cancel", "takeover"]);
  assert.deepEqual(builtinTaskControlMetadata({ id: "run", version: 3, status: "paused" }).allowedActions, ["resume", "cancel", "takeover"]);
  assert.deepEqual(builtinTaskControlMetadata({ id: "run", version: 4, status: "waiting_human" }).allowedActions, ["resume", "cancel", "takeover"]);
  for (const status of ["succeeded", "failed", "reconciliation_required", "cancelled"]) {
    assert.deepEqual(builtinTaskControlMetadata({ id: "run", version: 5, status }).allowedActions, [], status);
  }
});

test("PostgreSQL task detail gives editors versioned global-run controls while viewers remain read-only", options, async () => {
  const f = await createPostgresFixture();
  let runtime: BuiltinAgentRuntime | undefined;
  try {
    await migratePostgresFixture(f.db);
    await ensureTeamSchema(f.db, { bootstrapAdminUserId: 1 });
    const team = new TeamService(f.db);
    const editor = await team.createUser(1, { name: "task-control-editor", password: "task-control-password", role: "editor" });
    const viewer = await team.createUser(1, { name: "task-control-viewer", password: "task-control-password", role: "viewer" });
    const [project] = await f.db("o_project").insert({ userId: 1, name: "Global builtin work" }).returning("id");
    const projectId = Number(project.id);
    await ensureBuiltinAgentRuntimeSchema(f.db);
    runtime = new BuiltinAgentRuntime({ db: f.db, execute: async () => null, authorize: async () => undefined, workerId: "task-control-runtime" });
    const audio = await runtime.create({
      agentType: "productionAgent", projectId, scriptId: null, requestedBy: editor.id, prompt: "match voices", idempotencyKey: "task-control-audio",
      intent: { phase: "matchAudio", context: { projectId, roles: [{ id: 10, version: 1 }] } },
      limits: { maxModelCalls: 2, maxToolSteps: 12, maxOutputTokens: 2048, maxImageGenerations: 0, maxVideoGenerations: 0 },
    });
    const events = await runtime.create({
      agentType: "scriptAgent", projectId, scriptId: null, requestedBy: editor.id, prompt: "extract events", idempotencyKey: "task-control-events",
      intent: { phase: "novelEvents", context: { projectId, chapters: [{ id: 20, version: 1 }] } },
      limits: { maxModelCalls: 2, maxToolSteps: 10, maxOutputTokens: 2048, maxImageGenerations: 0, maxVideoGenerations: 0 },
    });
    await f.db("ext_builtin_runs").where({ id: audio.run.id }).update({ status: "waiting_human", version: 7, waitingQuestion: "Choose a voice", toolSteps: 4, currentStep: "audio.match", updatedAt: 100 });
    await f.db("ext_builtin_runs").where({ id: events.run.id }).update({ status: "succeeded", version: 3, toolSteps: 5, updatedAt: 101 });

    const list = await readTaskList(f.db, editor.id, { projectId, page: 1, limit: 20 });
    const audioTask = list.data.find((task) => task.sourceId === audio.run.id)!;
    const eventTask = list.data.find((task) => task.sourceId === events.run.id)!;
    assert.equal(audioTask.model, "角色音色匹配");
    assert.equal(eventTask.model, "原文事件提取");
    assert.deepEqual(audioTask.progress, { current: 4, total: null, phase: "audio.match" });

    const editorDetail = await readTaskDetail(f.db, editor.id, `builtin:${audio.run.id}`);
    assert.equal(editorDetail.waitingQuestion, "Choose a voice");
    assert.deepEqual(editorDetail.control, {
      runId: audio.run.id, version: 7, status: "waiting_human", allowedActions: ["resume", "cancel", "takeover"],
    });
    const viewerDetail = await readTaskDetail(f.db, viewer.id, `builtin:${audio.run.id}`);
    assert.equal("control" in viewerDetail, false);
    const terminal = await readTaskDetail(f.db, editor.id, `builtin:${events.run.id}`);
    assert.deepEqual(terminal.control?.allowedActions, []);
  } finally {
    if (runtime) await runtime.stop();
    await f.destroy();
  }
});
