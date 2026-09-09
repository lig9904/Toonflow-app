import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { ensureTeamSchema } from "../src/services/team";
import { ensureProductionStateSchema } from "../src/services/productionState";
import { ensureBuiltinAgentRuntimeSchema } from "../src/services/builtinAgentRuntime";
import { ensureImageJobsSchema } from "../src/services/imageJobs";
import { ensureVideoJobsSchema } from "../src/services/videoJobs";
import {
  createNovels,
  createProject,
  createScript,
  deleteNovel,
  deleteProject,
  deleteScripts,
  ensureProjectContentSchema,
  listScripts,
  loadEnabledProjectModels,
  readNovels,
  updateProject,
  type ProjectConfigurationMetadata,
} from "../src/services/projectContent";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const actor = { id: "human:1", kind: "human" as const };
const fields = {
  projectType: "novel", name: "Integrity", intro: "intro", type: "drama", artStyle: "ink",
  directorManual: "director", videoRatio: "16:9", imageModel: "enabled:image", videoModel: "enabled:video", imageQuality: "2K", mode: "text",
};
const metadata: ProjectConfigurationMetadata = {
  models: [
    { key: "enabled:image", type: "image", modes: ["text"] },
    { key: "enabled:video", type: "video", modes: ["text", ["imageReference:9", "videoReference:3"]] },
    { key: "enabled:text", type: "text", modes: [] },
  ],
  artStyles: ["ink"], directorManuals: ["director"],
};

const code = (wanted: string) => (error: unknown) => (error as { code?: unknown })?.code === wanted;

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureTeamSchema(f.db, { bootstrapAdminUserId: 1 });
  await ensureProjectContentSchema(f.db);
  return f;
}

test("project configuration validates enabled typed models and Web options without loading secrets", options, async () => {
  const f = await fixture();
  try {
    await f.db("o_vendorConfig").where({ id: "deepseek" }).update({ enable: 0, inputValues: JSON.stringify({ apiKey: "disabled-secret" }) });
    await f.db("o_vendorConfig").where({ id: "toonflow" }).update({ enable: 1, inputValues: JSON.stringify({ apiKey: "enabled-secret" }) });
    const requested: string[] = [];
    const loaded = await loadEnabledProjectModels(f.db, async (vendorId) => {
      requested.push(vendorId);
      return [{ modelName: "image", type: "image", mode: ["text"] }, { modelName: "video", type: "video", mode: ["text"] }];
    });
    assert.deepEqual(requested, ["toonflow"]);
    assert.equal(JSON.stringify(loaded).includes("secret"), false);

    const validMetadata = { ...metadata, models: loaded };
    const made = await createProject(f.db, { ...fields, imageModel: "toonflow:image", videoModel: "toonflow:video", idempotencyKey: "valid-project-configuration" }, 1, actor, validMetadata);
    assert.equal(made.project.imageModel, "toonflow:image");
    assert.equal(made.project.videoModel, "toonflow:video");

    const badCases = [
      { imageModel: "disabled:image" },
      { imageModel: "toonflow:video" },
      { videoModel: "toonflow:image" },
      { mode: "singleImage" },
      { imageQuality: "8K" },
      { videoRatio: "4:3" },
      { artStyle: "missing" },
      { directorManual: "missing" },
    ];
    for (const [index, patch] of badCases.entries()) {
      await assert.rejects(createProject(f.db, { ...fields, imageModel: "toonflow:image", videoModel: "toonflow:video", ...patch, idempotencyKey: `invalid-project-${index}` }, 1, actor, validMetadata), code("INVALID_INPUT"));
    }
    assert.equal(Number((await f.db("o_project").count("id as count").first())?.count), 1);

    await assert.rejects(updateProject(f.db, {
      ...fields, id: made.projectId, imageModel: "toonflow:image", videoModel: "toonflow:video", imageQuality: "8K",
      expectedVersion: 1, idempotencyKey: "invalid-project-update",
    }, actor, validMetadata), code("INVALID_INPUT"));
    assert.equal((await f.db("o_project").where({ id: made.projectId }).first()).imageQuality, "2K");
  } finally { await f.destroy(); }
});

test("versioned novel delete is atomic, idempotent, same-project scoped, and blocked by active work", options, async () => {
  const f = await fixture();
  try {
    await ensureImageJobsSchema(f.db);
    const project = await createProject(f.db, { ...fields, idempotencyKey: "novel-project" }, 1, actor);
    const other = await createProject(f.db, { ...fields, name: "Other", idempotencyKey: "novel-project-other" }, 1, actor);
    const created = await createNovels(f.db, { projectId: project.projectId, idempotencyKey: "novel-create", processEvents: false, data: [{ reel: "R", chapter: "C", chapterData: "body" }] }, actor);
    const novelId = created.novelIds[0];
    const [event] = await f.db("o_event").insert({ name: "event", detail: "detail" }).returning("id");
    await f.db("o_eventChapter").insert({ novelId, eventId: Number(event.id) });
    await f.db("ext_image_jobs").insert({
      idempotencyKey: "active-image", payloadHash: "hash", modelKey: "enabled:image", projectId: project.projectId,
      outputPath: "/pending.png", payload: "{}", status: "RESERVED", createdAt: 1, updatedAt: 1,
    });

    const input = { id: novelId, projectId: project.projectId, expectedVersion: 1, idempotencyKey: "novel-delete" };
    await assert.rejects(deleteNovel(f.db, input, actor), code("ACTIVE_TASK"));
    assert.ok(await f.db("o_novel").where({ id: novelId }).first());
    await f.db("ext_image_jobs").where({ projectId: project.projectId }).update({ status: "FAILED" });
    await assert.rejects(deleteNovel(f.db, { ...input, projectId: other.projectId, idempotencyKey: "novel-delete-foreign" }, actor), code("PROJECT_MISMATCH"));

    await f.db.raw(`CREATE FUNCTION reject_event_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced rollback'; END $$`);
    await f.db.raw(`CREATE TRIGGER reject_event_delete_trigger BEFORE DELETE ON "o_event" FOR EACH ROW EXECUTE FUNCTION reject_event_delete()`);
    await assert.rejects(deleteNovel(f.db, input, actor), /forced rollback/);
    assert.ok(await f.db("o_novel").where({ id: novelId }).first());
    assert.ok(await f.db("o_eventChapter").where({ novelId }).first());
    await f.db.raw(`DROP TRIGGER reject_event_delete_trigger ON "o_event"`);

    const removed = await deleteNovel(f.db, input, actor);
    const replay = await deleteNovel(f.db, input, actor);
    assert.equal(removed.deleted, true);
    assert.equal(replay.reused, true);
    assert.equal(await f.db("o_novel").where({ id: novelId }).first(), undefined);
    assert.equal(await f.db("o_event").where({ id: Number(event.id) }).first(), undefined);
  } finally { await f.destroy(); }
});

test("script and project deletion enforce versions, locks and durable-task quiescence before complete relational cleanup", options, async () => {
  const f = await fixture();
  try {
    await ensureProductionStateSchema(f.db);
    await ensureBuiltinAgentRuntimeSchema(f.db);
    await ensureVideoJobsSchema(f.db);
    const project = await createProject(f.db, { ...fields, idempotencyKey: "delete-project" }, 1, actor);
    const first = await createScript(f.db, { projectId: project.projectId, expectedVersion: 0, idempotencyKey: "delete-script-create", name: "Episode", content: "body" }, actor);
    const [storyboard] = await f.db("o_storyboard").insert({ projectId: project.projectId, scriptId: first.scriptId, prompt: "shot", duration: 2 }).returning("id");
    await f.db("ext_entity_state").insert({ entityType: "storyboard", entityId: Number(storyboard.id), projectId: project.projectId, version: 0, reviewState: "draft", locked: 1, lockedBy: actor.id })
      .onConflict(["entityType", "entityId"]).merge({ locked: 1, lockedBy: actor.id });

    const scriptInput = {
      projectId: project.projectId, ids: [first.scriptId], versions: [{ id: first.scriptId, expectedVersion: 1 }],
      workspaceExpectedVersion: first.workspaceVersion, idempotencyKey: "delete-script",
    };
    await assert.rejects(deleteScripts(f.db, scriptInput, actor), code("LOCKED"));
    assert.ok(await f.db("o_script").where({ id: first.scriptId }).first());
    await f.db("ext_entity_state").where({ entityType: "storyboard", entityId: Number(storyboard.id) }).update({ locked: 0, lockedBy: null });
    await assert.rejects(deleteScripts(f.db, { ...scriptInput, versions: [{ id: first.scriptId, expectedVersion: 0 }], idempotencyKey: "delete-script-stale" }, actor), code("VERSION_CONFLICT"));
    const removedScript = await deleteScripts(f.db, scriptInput, actor);
    assert.equal(removedScript.workspaceVersion, first.workspaceVersion + 1);
    assert.equal((await listScripts(f.db, project.projectId)).scripts.length, 0);
    assert.equal(await f.db("o_storyboard").where({ id: Number(storyboard.id) }).first(), undefined);

    const second = await createScript(f.db, { projectId: project.projectId, expectedVersion: removedScript.workspaceVersion, idempotencyKey: "second-script", name: "Second", content: "body" }, actor);
    const novel = await createNovels(f.db, { projectId: project.projectId, idempotencyKey: "project-novel", processEvents: false, data: [{ reel: "", chapter: "chapter", chapterData: "text" }] }, actor);
    const [track] = await f.db("o_videoTrack").insert({ projectId: project.projectId, scriptId: second.scriptId, duration: 2 }).returning("id");
    const [video] = await f.db("o_video").insert({ projectId: project.projectId, scriptId: second.scriptId, videoTrackId: Number(track.id), state: "pending" }).returning("id");
    await f.db("ext_video_jobs").insert({
      idempotencyKey: "active-video", payloadHash: "hash", modelKey: "enabled:video", projectId: project.projectId,
      scriptId: second.scriptId, trackId: Number(track.id), videoId: Number(video.id), outputPath: "/pending.mp4", payload: "{}",
      status: "SUBMITTED", pollAttempts: 0, queryFailures: 0, downloadFailures: 0, createdAt: 1, updatedAt: 1,
    });
    await assert.rejects(deleteProject(f.db, { id: project.projectId, expectedVersion: 1, idempotencyKey: "project-delete-active" }, actor), code("ACTIVE_TASK"));
    await f.db("ext_video_jobs").where({ projectId: project.projectId }).update({ status: "FAILED" });
    const removedProject = await deleteProject(f.db, { id: project.projectId, expectedVersion: 1, idempotencyKey: "project-delete" }, actor);
    const replay = await deleteProject(f.db, { id: project.projectId, expectedVersion: 1, idempotencyKey: "project-delete" }, actor);
    assert.equal(removedProject.deleted, true);
    assert.equal(replay.reused, true);
    for (const table of ["o_project", "o_script", "o_novel", "o_storyboard", "o_videoTrack", "o_video", "ext_video_jobs"]) {
      const column = table === "o_project" ? "id" : "projectId";
      assert.equal(Number((await f.db(table).where({ [column]: project.projectId }).count("* as count").first())?.count), 0, table);
    }
    assert.equal((await readNovels(f.db, project.projectId, novel.novelIds)).length, 0);
  } finally { await f.destroy(); }
});
