import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { ensureTeamSchema, TeamService } from "../src/services/team";
import {
  applyNovelEventResult, createProject, createScript, createNovels, ensureProjectContentSchema,
  listProjects, listScripts, readNovels, updateProject, updateScript, updateNovel,
} from "../src/services/projectContent";
import { legacyArrayResponse, scriptListResponse } from "../src/services/projectContent/http";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const actor = { id: "human:1", kind: "human" as const };
const fields = {
  projectType: "series", name: "Shared show", intro: "intro", type: "drama", artStyle: "ink",
  directorManual: "director", videoRatio: "16:9", imageModel: "image", videoModel: "video", imageQuality: "2K", mode: "normal",
};
const code = (wanted: string) => (error: unknown) => (error as { code?: unknown })?.code === wanted;

test("different episodes can be created and edited from the same workspace snapshot without clobbering each other", options, async () => {
  const f = await fixture();
  try {
    const made = await projectFixture(f);
    const created = await Promise.all(["one", "two"].map((name) => createScript(f.db, { projectId: made.projectId, expectedVersion: 0, idempotencyKey: `parallel-create-${name}`, name, content: name }, actor)));
    const snapshot = await listScripts(f.db, made.projectId);
    const requests = created.map((item) => ({ id: item.scriptId, projectId: made.projectId, expectedVersion: item.script.version, workspaceExpectedVersion: snapshot.workspaceVersion,
      name: item.script.name, content: `edited ${item.script.name}`, idempotencyKey: `parallel-edit-${item.scriptId}` }));
    const updated = await Promise.all(requests.map((input) => updateScript(f.db, input, actor)));
    assert.equal(updated.length, 2);
    assert.deepEqual((await listScripts(f.db, made.projectId)).scripts.map((script) => script.content).sort(), ["edited one", "edited two"]);
    assert.equal((await updateScript(f.db, requests[0], actor)).reused, true);
    await assert.rejects(updateScript(f.db, { ...requests[0], idempotencyKey: "stale-same-episode", content: "late" }, actor), code("VERSION_CONFLICT"));
  } finally { await f.destroy(); }
});
async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureTeamSchema(f.db, { bootstrapAdminUserId: 1 });
  await ensureProjectContentSchema(f.db);
  const team = new TeamService(f.db);
  const editor = await team.createUser(1, { name: "content-editor", password: "content-editor-123", role: "editor" });
  const viewer = await team.createUser(1, { name: "content-viewer", password: "content-viewer-123", role: "viewer" });
  return { ...f, editor, viewer };
}
async function projectFixture(f: Awaited<ReturnType<typeof fixture>>, key = "project-create-1") {
  return createProject(f.db, { ...fields, idempotencyKey: key }, 1, actor);
}

test("project create is transactional, idempotent, and permits duplicate names with different keys", options, async () => {
  const f = await fixture();
  try {
    const first = await projectFixture(f);
    const replay = await projectFixture(f);
    const sameName = await projectFixture(f, "project-create-2");
    assert.equal(replay.reused, true);
    assert.equal(replay.projectId, first.projectId);
    assert.notEqual(sameName.projectId, first.projectId);
    assert.equal(first.project.version, 1);
    assert.equal((await f.db("team_projects").where({ team_key: "shared" })).length, 2);
    await assert.rejects(createProject(f.db, { ...fields, intro: "different", idempotencyKey: "project-create-1" }, 1, actor), code("IDEMPOTENCY_CONFLICT"));
    const projects = await listProjects(f.db, f.viewer.id);
    assert.deepEqual(projects.map((p) => p.id), [first.projectId, sameName.projectId]);
    assert.ok(Array.isArray(legacyArrayResponse(projects).data), "legacy read payload remains an array");
    await assert.rejects(createProject(f.db, { ...fields, idempotencyKey: "key-one-1", mutationKey: "key-two-2" }, 1, actor), code("IDEMPOTENCY_CONFLICT"));
  } finally { await f.destroy(); }
});

test("concurrent project edits have one CAS winner", options, async () => {
  const f = await fixture();
  try {
    const made = await projectFixture(f);
    const results = await Promise.allSettled(["A", "B"].map((intro) => updateProject(f.db, {
      ...fields, id: made.projectId, expectedVersion: 1, mutationKey: "project-edit-" + intro, intro,
    }, actor)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const current = (await listProjects(f.db, f.editor.id)).find((p) => p.id === made.projectId)!;
    assert.equal(current.version, 2);
    assert.ok(current.intro === "A" || current.intro === "B");
  } finally { await f.destroy(); }
});

test("script writes share workspace CAS, return IDs, preserve omitted bindings, clear empty bindings, and reject foreign assets", options, async () => {
  const f = await fixture();
  try {
    const p1 = await projectFixture(f);
    const p2 = await projectFixture(f, "project-create-other");
    const [asset] = await f.db("o_assets").insert({ projectId: p1.projectId, name: "hero", type: "role" }).returning("id");
    const [foreign] = await f.db("o_assets").insert({ projectId: p2.projectId, name: "foreign", type: "role" }).returning("id");
    const created = await createScript(f.db, { projectId: p1.projectId, expectedVersion: 0, idempotencyKey: "script-create-1", name: "Episode", content: "one", assets: [Number(asset.id)] }, actor);
    const duplicateName = await createScript(f.db, { projectId: p1.projectId, expectedVersion: 1, idempotencyKey: "script-create-2", name: "Episode", content: "two" }, actor);
    assert.notEqual(created.scriptId, duplicateName.scriptId);
    assert.deepEqual(created.script.assets, [Number(asset.id)]);
    const listedWithAsset = await listScripts(f.db, p1.projectId);
    assert.deepEqual(listedWithAsset.scripts.find((s) => s.id === created.scriptId)?.relatedAssets, [{ id: Number(asset.id), name: "hero" }]);
    const preserved = await updateScript(f.db, { id: created.scriptId, projectId: p1.projectId, expectedVersion: 1, workspaceExpectedVersion: 2, idempotencyKey: "script-preserve", name: "Episode", content: "preserved" }, actor);
    assert.deepEqual(preserved.script.assets, [Number(asset.id)]);
    const cleared = await updateScript(f.db, { id: created.scriptId, projectId: p1.projectId, expectedVersion: 2, workspaceExpectedVersion: 3, idempotencyKey: "script-clear", name: "Episode", content: "cleared", assets: [] }, actor);
    assert.deepEqual(cleared.script.assets, []);
    await assert.rejects(createScript(f.db, { projectId: p1.projectId, expectedVersion: 4, idempotencyKey: "script-foreign", name: "bad", content: "bad", assets: [Number(foreign.id)] }, actor), (e: unknown) => (e as any)?.code === "PROJECT_MISMATCH");
    const beforeRace = await listScripts(f.db, p1.projectId);
    assert.deepEqual(beforeRace.scripts.find((s) => s.id === duplicateName.scriptId)?.relatedAssets, []);
    assert.deepEqual(beforeRace.scripts.find((s) => s.id === created.scriptId)?.relatedAssets, []);
    const response = scriptListResponse(beforeRace.scripts, beforeRace.workspaceVersion);
    assert.ok(Array.isArray(response.data));
    assert.equal(response.workspaceVersion, beforeRace.workspaceVersion);
    const row = beforeRace.scripts.find((s) => s.id === created.scriptId)!;
    const race = await Promise.allSettled(["left", "right"].map((content) => updateScript(f.db, {
      id: row.id, projectId: p1.projectId, expectedVersion: row.version, workspaceExpectedVersion: beforeRace.workspaceVersion,
      idempotencyKey: "script-race-" + content, name: row.name, content,
    }, actor)));
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  } finally { await f.destroy(); }
});

test("pure novel import is idempotent, serializes chapter indexes, and stale results cannot overwrite edits", options, async () => {
  const f = await fixture();
  try {
    const made = await projectFixture(f);
    const input = { projectId: made.projectId, idempotencyKey: "novel-import-1", processEvents: false, data: [{ index: 99, reel: "R", chapter: "Same", chapterData: "A" }, { index: 99, reel: "R", chapter: "Same", chapterData: "B" }] };
    const first = await createNovels(f.db, input, actor);
    const replay = await createNovels(f.db, input, actor);
    assert.equal(replay.reused, true);
    assert.deepEqual(replay.novelIds, first.novelIds);
    assert.deepEqual(first.novels.map((n) => Number(n.chapterIndex)), [1, 2]);
    assert.ok(first.novels.every((n) => n.eventState === null), "pure import leaves event processing untouched");
    const concurrent = await Promise.all([
      createNovels(f.db, { projectId: made.projectId, idempotencyKey: "novel-import-A", processEvents: false, data: [{ reel: "", chapter: "A", chapterData: "A" }] }, actor),
      createNovels(f.db, { projectId: made.projectId, idempotencyKey: "novel-import-B", processEvents: false, data: [{ reel: "", chapter: "B", chapterData: "B" }] }, actor),
    ]);
    assert.equal(concurrent.length, 2);
    assert.deepEqual((await readNovels(f.db, made.projectId)).map((n) => Number(n.chapterIndex)), [1, 2, 3, 4]);
    const target = first.novels[0];
    await updateNovel(f.db, { id: target.id, projectId: made.projectId, expectedVersion: 1, idempotencyKey: "novel-edit-new", index: 1, reel: "R", chapter: "Same", chapterData: "human" }, actor);
    await assert.rejects(updateNovel(f.db, { id: target.id, projectId: made.projectId, expectedVersion: 1, idempotencyKey: "novel-edit-late", index: 1, reel: "R", chapter: "Same", chapterData: "late" }, actor), code("VERSION_CONFLICT"));
    await assert.rejects(applyNovelEventResult(f.db, { id: target.id, projectId: made.projectId, expectedVersion: 1, event: "late model output", actor: { id: "system:test-event", kind: "system" } }), code("VERSION_CONFLICT"));
    assert.equal((await readNovels(f.db, made.projectId, [target.id]))[0].chapterData, "human");
  } finally { await f.destroy(); }
});
