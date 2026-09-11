import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPostgresFixture, migratePostgresFixture } from "../../src/lib/postgresTest";
import {
  ensureTeamSchema, getTeamUser, issueTeamSession, resolveTeamSession, revokeTeamSession,
  requireProjectAccess, TeamSecurityError, TeamService,
} from "../../src/services/team";
import {
  authorizeRoute, getRouteAuthorization, listAccessibleProjects, requireMediaAccess,
  requireProjectResourceAccess,
} from "../../src/services/team/authorization";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const rejectedWith = (code: string) => (error: unknown) => error instanceof TeamSecurityError && error.code === code;

async function fixture() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureTeamSchema(f.db, { bootstrapAdminUserId: 1 });
  const service = new TeamService(f.db);
  const editor = await service.createUser(1, { name: "editor", password: "editor-pass-123", role: "editor" });
  const viewer = await service.createUser(1, { name: "viewer", password: "viewer-pass-123", role: "viewer" });
  const disabled = await service.createUser(1, { name: "disabled", password: "disabled-pass-123", role: "viewer" });
  const secondAdmin = await service.createUser(1, { name: "second-admin", password: "second-admin-123", role: "admin" });
  await service.updateUser(1, { id: disabled.id, expectedVersion: disabled.version, enabled: false });
  const [editorProjectRow] = await f.db("o_project").insert({ name: "editor project", userId: editor.id }).returning("id");
  const [adminProjectRow] = await f.db("o_project").insert({ name: "admin project", userId: 1 }).returning("id");
  const [foreignUser] = await f.db("o_user").insert({ name: "not-a-member", password: "unused" }).returning("id");
  const [foreignProjectRow] = await f.db("o_project").insert({ name: "foreign project", userId: foreignUser.id }).returning("id");
  await f.db("team_projects").insert({ project_id: foreignProjectRow.id, team_key: "foreign-team" });
  return {
    ...f, service, editor, viewer, disabled, secondAdmin,
    editorProject: Number(editorProjectRow.id), adminProject: Number(adminProjectRow.id),
    foreignUserId: Number(foreignUser.id), foreignProject: Number(foreignProjectRow.id),
  };
}

test("the five-member shared team can collaborate while roles and associations remain enforced", options, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.db("team_users")).length, 5);
    assert.equal((await requireProjectAccess(f.db, f.editor.id, f.adminProject, "edit")).role, "editor");
    assert.equal((await requireProjectAccess(f.db, f.viewer.id, f.editorProject, "read")).role, "viewer");
    await assert.rejects(requireProjectAccess(f.db, f.viewer.id, f.editorProject, "edit"), rejectedWith("PROJECT_ACTION_FORBIDDEN"));
    await assert.rejects(requireProjectAccess(f.db, f.editor.id, f.adminProject, "review"), rejectedWith("PROJECT_ACTION_FORBIDDEN"));
    assert.equal((await requireProjectAccess(f.db, f.editor.id, f.editorProject, "review")).role, "editor");
    assert.equal((await requireProjectAccess(f.db, f.secondAdmin.id, f.editorProject, "review")).role, "admin");
    await assert.rejects(requireProjectAccess(f.db, f.foreignUserId, f.editorProject, "read"), rejectedWith("USER_NOT_FOUND"));
    await assert.rejects(requireProjectAccess(f.db, f.editor.id, f.foreignProject, "read"), rejectedWith("PROJECT_NOT_FOUND"));
    await assert.rejects(getTeamUser(f.db, f.disabled.id), rejectedWith("USER_DISABLED"));
    assert.deepEqual((await listAccessibleProjects(f.db, f.viewer.id)).map((row: any) => Number(row.id)), [f.editorProject, f.adminProject]);
  } finally { await f.destroy(); }
});

test("schema bootstrap is explicit and a restart never promotes or revives a user", options, async () => {
  const f = await createPostgresFixture();
  try {
    await migratePostgresFixture(f.db);
    await assert.rejects(ensureTeamSchema(f.db), rejectedWith("ADMIN_REQUIRED"));
    const seeded = await f.db("team_users").where({ user_id: 1 }).first();
    assert.equal(seeded.role, "editor");
    await f.db("team_users").where({ user_id: 1 }).update({ role: "admin", enabled: false });
    await assert.rejects(ensureTeamSchema(f.db, { bootstrapAdminUserId: 1 }), rejectedWith("ADMIN_REQUIRED"));
    const afterRestart = await f.db("team_users").where({ user_id: 1 }).first();
    assert.equal(afterRestart.role, "admin");
    assert.equal(afterRestart.enabled, false);
  } finally { await f.destroy(); }
});

test("media and resource authorization resolves the database owner and rejects fabricated project IDs", options, async () => {
  const f = await fixture();
  try {
    const [asset] = await f.db("o_assets").insert({ projectId: f.editorProject, name: "asset", type: "role" }).returning("id");
    const [image] = await f.db("o_image").insert({ assetsId: asset.id, filePath: "/shared/editor.png", type: "image" }).returning("id");
    const [derived] = await f.db("o_assets").insert({ projectId: f.editorProject, name: "derived", type: "role" }).returning("id");
    await f.db("o_image").insert({ assetsId: derived.id, filePath: "edited/derived.png", type: "image" });
    assert.equal((await requireMediaAccess(f.db, f.viewer.id, { table: "o_image", id: image.id })).id, f.viewer.id);
    assert.equal((await requireMediaAccess(f.db, f.viewer.id, { filePath: "/shared/editor.png" })).id, f.viewer.id);
    assert.equal((await requireMediaAccess(f.db, f.viewer.id, { filePath: "/oss/edited/derived.png" })).id, f.viewer.id);
    await assert.rejects(requireMediaAccess(f.db, f.editor.id, { projectId: f.adminProject, table: "o_image", id: image.id }), rejectedWith("PROJECT_MISMATCH"));
    await assert.rejects(requireMediaAccess(f.db, f.editor.id, { projectId: f.editorProject, filePath: "/unrecorded/path.png" }), rejectedWith("MEDIA_FORBIDDEN"));
    await assert.rejects(requireMediaAccess(f.db, f.editor.id, { filePath: "/oss/../edited/derived.png" }), rejectedWith("MEDIA_FORBIDDEN"));
    await assert.rejects(requireMediaAccess(f.db, f.editor.id, { filePath: "/oss//edited/derived.png" }), rejectedWith("MEDIA_FORBIDDEN"));
    const [foreignAsset] = await f.db("o_assets").insert({ projectId: f.foreignProject, name: "foreign alias", type: "role" }).returning("id");
    await f.db("o_image").insert({ assetsId: foreignAsset.id, filePath: "/edited/derived.png", type: "image" });
    await assert.rejects(requireMediaAccess(f.db, f.viewer.id, { filePath: "/oss/edited/derived.png" }), rejectedWith("MEDIA_FORBIDDEN"));
    await assert.rejects(requireProjectResourceAccess(f.db, f.editor.id, { projectId: f.adminProject, table: "o_assets", id: asset.id }, "edit"), rejectedWith("PROJECT_MISMATCH"));
  } finally { await f.destroy(); }
});

test("concurrent demotions serialize on the team invariant and retain one enabled admin", options, async () => {
  const f = await fixture();
  try {
    const first = await getTeamUser(f.db, 1);
    const second = await getTeamUser(f.db, f.secondAdmin.id);
    const results = await Promise.allSettled([
      f.service.updateUser(1, { id: 1, expectedVersion: first.version, role: "editor" }),
      f.service.updateUser(f.secondAdmin.id, { id: f.secondAdmin.id, expectedVersion: second.version, role: "editor" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(failure && rejectedWith("LAST_ADMIN")(failure.reason));
    const [{ count }] = await f.db("team_users").where({ role: "admin", enabled: true }).count("user_id as count");
    assert.equal(Number(count), 1);
  } finally { await f.destroy(); }
});

test("sessions are HttpOnly and role or enabled changes revoke prior credentials", options, async () => {
  const f = await fixture();
  try {
    const session = await issueTeamSession(f.db, f.editor.id, { now: 1_700_000_000_000, ttlMs: 60_000 });
    assert.match(session.cookie, /HttpOnly/);
    assert.match(session.cookie, /SameSite=Lax/);
    assert.equal((await resolveTeamSession(f.db, session.token, { now: 1_700_000_010_000 })).id, f.editor.id);
    await f.service.updateUser(1, { id: f.editor.id, expectedVersion: f.editor.version, role: "viewer" });
    await assert.rejects(resolveTeamSession(f.db, session.token, { now: 1_700_000_020_000 }), rejectedWith("SESSION_REVOKED"));
    const replacement = await issueTeamSession(f.db, f.editor.id);
    await revokeTeamSession(f.db, replacement.token);
    await assert.rejects(resolveTeamSession(f.db, replacement.token), rejectedWith("SESSION_INVALID"));
  } finally { await f.destroy(); }
});

test("an administrative create waiting behind revocation cannot replay stale authority", options, async () => {
  const f = await fixture();
  try {
    const session = await issueTeamSession(f.db, 1);
    const blocker = await f.db.transaction();
    await blocker.raw("SELECT pg_advisory_xact_lock(?)", [8_425_117_304_991]);
    const pendingCreate = f.service.createUser(1, { name: "must-not-exist", password: "must-not-exist-123", role: "editor" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    await blocker("team_users").where({ user_id: 1 }).update({ enabled: false, session_revision: blocker.raw('"session_revision" + 1') });
    await blocker.commit();
    await assert.rejects(pendingCreate, rejectedWith("USER_DISABLED"));
    assert.equal(await f.db("o_user").where({ name: "must-not-exist" }).first(), undefined);
    await assert.rejects(resolveTeamSession(f.db, session.token), rejectedWith("USER_DISABLED"));
  } finally { await f.destroy(); }
});

test("the route registry is exact, complete for router.ts, and classifies reads and administration deliberately", options, async () => {
  const routerSource = await readFile(resolve(process.cwd(), "src/router.ts"), "utf8");
  const paths = [...routerSource.matchAll(/app\.use\("([^"]+)"/g)].map((match) => match[1]);
  const getRoutes = new Set(["/api/other/getVersion", "/api/setting/agentDeploy/getAgentUseMode", "/api/setting/dbConfig/dbInfo", "/api/setting/dbConfig/exportData", "/api/setting/dev/getSwitchAiDevTool", "/api/setting/loginConfig/getUser", "/api/setting/memoryConfig/getMemory", "/api/setting/modelMap/getPromptList", "/api/test/test"]);
  const missing = paths.filter((path) => !getRouteAuthorization(getRoutes.has(path) ? "GET" : "POST", path));
  assert.deepEqual(missing, []);
  assert.equal(getRouteAuthorization("POST", "/api/setting/loginConfig/getUser"), undefined);
  assert.equal(getRouteAuthorization("POST", "/api/assets/pollingImageAssets")?.action, "read");
  assert.equal(getRouteAuthorization("POST", "/api/project/getModelDetails")?.action, "read");
  assert.equal(getRouteAuthorization("POST", "/api/setting/vendorConfig/deleteVendor")?.scope, "admin");
  assert.equal(getRouteAuthorization("POST", "/api/other/deleteAllData")?.scope, "admin");
  assert.equal(getRouteAuthorization("POST", "/api/project/addDirectorManual")?.scope, "admin");
  assert.equal(getRouteAuthorization("POST", "/api/builtinAgent/list")?.action, "read");
  assert.equal(getRouteAuthorization("POST", "/api/builtinAgent/get")?.resources?.[0].table, "ext_builtin_runs");
  assert.equal(getRouteAuthorization("POST", "/api/assetsGenerate/batchGenerateImageAssets")?.resources?.[0].nestedIdField, "id");
  assert.equal(getRouteAuthorization("POST", "/api/assetsGenerate/batchPolishAssetsPrompt")?.resources?.[0].nestedIdField, "assetsId");
  assert.equal(getRouteAuthorization("POST", "/api/models/delight"), undefined);
});

test("route authorization rechecks membership and rejects cross-project resource arrays", options, async () => {
  const f = await fixture();
  try {
    const principal = await getTeamUser(f.db, f.editor.id);
    await assert.rejects(authorizeRoute({ db: f.db }, "POST", "/api/unknown/action", principal), rejectedWith("UNKNOWN_OPERATION"));
    const [script] = await f.db("o_script").insert({ projectId: f.editorProject, name: "one" }).returning("id");
    const [foreignAsset] = await f.db("o_assets").insert({ projectId: f.adminProject, name: "other", type: "role" }).returning("id");
    const [localAsset] = await f.db("o_assets").insert({ projectId: f.editorProject, name: "local", type: "role" }).returning("id");
    await assert.rejects(authorizeRoute({ db: f.db }, "POST", "/api/script/addScript", principal, { body: { projectId: f.editorProject, assets: [foreignAsset.id] } } as any), rejectedWith("PROJECT_MISMATCH"));
    await authorizeRoute({ db: f.db }, "POST", "/api/assetsGenerate/batchGenerateImageAssets", principal, { body: { projectId: f.editorProject, items: [{ id: localAsset.id }] } } as any);
    await authorizeRoute({ db: f.db }, "POST", "/api/assetsGenerate/batchPolishAssetsPrompt", principal, { body: { projectId: f.editorProject, items: [{ assetsId: localAsset.id }] } } as any);
    await assert.rejects(authorizeRoute({ db: f.db }, "POST", "/api/assetsGenerate/batchGenerateImageAssets", principal, { body: { projectId: f.editorProject, items: [{ assetsId: localAsset.id }] } } as any), rejectedWith("INVALID_ID"));
    await assert.rejects(authorizeRoute({ db: f.db }, "POST", "/api/assetsGenerate/batchPolishAssetsPrompt", principal, { body: { projectId: f.editorProject, items: [{ id: localAsset.id }] } } as any), rejectedWith("INVALID_ID"));
    await assert.rejects(authorizeRoute({ db: f.db }, "POST", "/api/assetsGenerate/batchGenerateImageAssets", principal, { body: { projectId: f.editorProject, items: [{ id: foreignAsset.id }] } } as any), rejectedWith("PROJECT_MISMATCH"));
    await f.db.schema.createTable("ext_builtin_runs", (table) => { table.text("id").primary(); table.bigInteger("projectId"); });
    const runId = "12345678-1234-1234-1234-123456789abc";
    await f.db("ext_builtin_runs").insert({ id: runId, projectId: f.editorProject });
    await authorizeRoute({ db: f.db }, "POST", "/api/builtinAgent/get", principal, { body: { runId } } as any);
    const viewer = await getTeamUser(f.db, f.viewer.id);
    await assert.rejects(authorizeRoute({ db: f.db }, "POST", "/api/builtinAgent/control", viewer, { body: { runId } } as any), rejectedWith("PROJECT_ACTION_FORBIDDEN"));
    await f.service.updateUser(1, { id: f.editor.id, expectedVersion: f.editor.version, enabled: false });
    await assert.rejects(authorizeRoute({ db: f.db }, "POST", "/api/script/pollScriptAssets", principal, { body: { ids: [script.id] } } as any), rejectedWith("USER_DISABLED"));
  } finally { await f.destroy(); }
});
