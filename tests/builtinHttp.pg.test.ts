import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureTeamSchema, TeamService, teamAuthMiddleware, requireProjectAccess, getTeamUser, associateProjectWithTeam } from "../src/services/team";
import { createApplicationSessionHandlers, createApplicationSessionRouter, updateAccountPassword } from "../src/services/applicationSession";
import { createTeamRouter } from "../src/routes/team";
import { ensureCreativeWorkspaceSchema, readScriptWorkspace } from "../src/services/creativeWorkspace";
import { createScriptWorkspaceHandlers } from "../src/services/creativeWorkspace/http";
import { BuiltinAgentRuntime, ensureBuiltinAgentRuntimeSchema } from "../src/services/builtinAgentRuntime";
import { createBuiltinAgentRouter } from "../src/services/builtinAgent/http";
import { createScriptAgentExecutor, type StructuredScriptModel } from "../src/services/builtinAgent/scriptExecutor";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const legacyKey = "isolated-http-fixture-signing-key";
async function setup() {
  const f = await createPostgresFixture();
  await migratePostgresFixture(f.db);
  await ensureTeamSchema(f.db, { bootstrapAdminUserId: 1 });
  await ensureCreativeWorkspaceSchema(f.db);
  await ensureBuiltinAgentRuntimeSchema(f.db);
  const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "Shared HTTP project", projectType: "script" });
  await associateProjectWithTeam(f.db, projectId);
  const team = new TeamService(f.db);
  const users = await Promise.all([
    team.createUser(1, { name: "editor-a", password: "fixture-password-a", role: "editor" }),
    team.createUser(1, { name: "editor-b", password: "fixture-password-b", role: "editor" }),
    team.createUser(1, { name: "editor-c", password: "fixture-password-c", role: "editor" }),
    team.createUser(1, { name: "viewer", password: "fixture-password-d", role: "viewer" }),
  ]);
  let modelCalls = 0;
  const modelRequests: Array<{ role: string; thinkLevel: number }> = [];
  const model: StructuredScriptModel = { async generate(req) {
    modelCalls += 1;
    modelRequests.push({ role: req.role, thinkLevel: req.thinkLevel });
    const value = req.role === "scriptAgent:decisionAgent"
      ? { actions: ["script"], chapterIds: [], targetScriptIds: [], question: null, summary: "准备剧本" }
      : { script: [{ id: null, name: "HTTP episode", content: "Created without a browser callback", assets: [] }], summary: "完成" };
    return { value: req.schema.parse(value), outputTokens: 10 };
  } };
  const runtime = new BuiltinAgentRuntime({ db: f.db, authorize: async (run) => { await requireProjectAccess(f.db, run.requestedBy, run.projectId!, "edit"); }, execute: createScriptAgentExecutor({ db: f.db, model, loadSkill: async () => "fixture skill" }) });
  const app = express();
  app.use(express.json());
  const sessionOptions = { db: f.db, secureCookies: false, legacySigningKey: async () => legacyKey };
  app.post("/api/login/login", createApplicationSessionHandlers(sessionOptions).login);
  app.use("/api/session", createApplicationSessionRouter(sessionOptions));
  app.use(teamAuthMiddleware(f.db));
  app.use((req, _res, next) => { (req as any).user = (req as any).teamPrincipal; next(); });
  app.use("/api/team", createTeamRouter({ db: f.db, authenticate: async (req) => (req as any).teamPrincipal }));
  app.use("/api/builtinAgent", createBuiltinAgentRouter({ runtime, userId: async (req) => (req as any).user.id, authorize: async (userId, pid, action, scriptId) => {
    await requireProjectAccess(f.db, userId, pid, action);
    if (scriptId != null && !(await f.db("o_script").where({ id: scriptId, projectId: pid }).first())) throw Object.assign(new Error("Foreign episode"), { status: 403 });
  } }));
  const workspace = createScriptWorkspaceHandlers(f.db, async (req, pid, action) => {
    await requireProjectAccess(f.db, (req as any).user.id, pid, action);
    return { id: `human:${(req as any).user.id}`, kind: "human" };
  });
  app.post("/api/scriptAgent/getPlanData", workspace.get);
  app.post("/api/scriptAgent/setPlanData", workspace.save);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  async function post(route: string, body: unknown = {}, cookie?: string, extra?: Record<string, string>) {
    const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0], headers: response.headers };
  }
  async function login(username: string, password: string) {
    const result = await post("/api/login/login", { username, password });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert(result.cookie);
    assert.equal(result.body.data.token, undefined);
    assert.equal(result.body.data.authenticated, true);
    assert.match(result.headers.get("set-cookie")!, /HttpOnly/);
    assert(!JSON.stringify(result.body).includes(result.cookie.split("=")[1]));
    return result.cookie;
  }
  return { ...f, projectId, users, runtime, post, login, modelRequests, get modelCalls() { return modelCalls; }, async close() {
    await runtime.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.destroy();
  } };
}

test("five independent cookie sessions share a project with real read/edit roles", options, async () => {
  const f = await setup();
  try {
    const cookies = await Promise.all([f.login("admin", "admin123"), f.login("editor-a", "fixture-password-a"), f.login("editor-b", "fixture-password-b"), f.login("editor-c", "fixture-password-c"), f.login("viewer", "fixture-password-d")]);
    assert.equal(new Set(cookies).size, 5);
    const reads = await Promise.all(cookies.map((cookie) => f.post("/api/scriptAgent/getPlanData", { projectId: f.projectId, agentType: "scriptAgent" }, cookie)));
    assert(reads.every((r) => r.status === 200), JSON.stringify(reads.map((r) => r.body)));
    const createInput = { projectId: f.projectId, agentType: "scriptAgent", prompt: "Write an episode", idempotencyKey: "http-run-creation", thinkLevel: 2 };
    const create = await f.post("/api/builtinAgent/start", createInput, cookies[1]);
    assert.equal(create.status, 200, JSON.stringify(create.body));
    assert.deepEqual(create.body.data.run.intent, { thinkLevel: 2 });
    const persisted = await f.db("ext_builtin_runs").where({ id: create.body.data.run.id }).first("intent");
    assert.deepEqual(persisted.intent, { thinkLevel: 2 });
    const duplicate = await f.post("/api/builtinAgent/start", createInput, cookies[1]);
    assert.equal(duplicate.body.data.reused, true);
    const conflictingLevel = await f.post("/api/builtinAgent/start", { ...createInput, thinkLevel: 3 }, cookies[1]);
    assert.equal(conflictingLevel.status, 409);
    assert.equal(conflictingLevel.body.code, "CONFLICT");
    const invalidLevel = await f.post("/api/builtinAgent/start", { ...createInput, idempotencyKey: "http-run-invalid-level", thinkLevel: 4 }, cookies[1]);
    assert.equal(invalidLevel.status, 400);
    assert.equal(invalidLevel.body.code, "INVALID_INPUT");
    const denied = await f.post("/api/builtinAgent/start", { projectId: f.projectId, agentType: "scriptAgent", prompt: "Write", idempotencyKey: "viewer-run-creation" }, cookies[4]);
    assert.equal(denied.status, 403);
    await f.runtime.runOnce();
    assert.equal(f.modelCalls, 2);
    assert.deepEqual(f.modelRequests, [
      { role: "scriptAgent:decisionAgent", thinkLevel: 2 },
      { role: "scriptAgent:scriptAgent", thinkLevel: 2 },
    ]);
    const id = create.body.data.run.id;
    const visible = await f.post("/api/builtinAgent/get", { runId: id, afterSequence: 0 }, cookies[4]);
    assert.equal(visible.body.data.run.status, "succeeded", JSON.stringify(visible.body));
    assert(visible.body.data.events.some((e: any) => e.type === "artifact.saved"));
    assert.equal((await readScriptWorkspace(f.db, f.projectId)).script[0].content, "Created without a browser callback");
    const forbiddenControl = await f.post("/api/builtinAgent/control", { runId: id, expectedVersion: visible.body.data.run.version, action: "takeover" }, cookies[4]);
    assert.equal(forbiddenControl.status, 403);
    const pollAgain = await f.post("/api/builtinAgent/get", { runId: id, afterSequence: visible.body.data.nextSequence }, cookies[1]);
    assert.equal(pollAgain.body.data.events.length, 0);
    assert.equal(f.modelCalls, 2);
    const legacyInput = { projectId: f.projectId, agentType: "scriptAgent", prompt: "Legacy start", idempotencyKey: "http-run-legacy-shape" };
    const legacy = await f.post("/api/builtinAgent/start", legacyInput, cookies[1]);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.data.run.intent, null);
    const legacyDuplicate = await f.post("/api/builtinAgent/start", legacyInput, cookies[1]);
    assert.equal(legacyDuplicate.body.data.reused, true);
  } finally { await f.close(); }
});

test("cookie logout/revocation and CSRF enforce the real session boundary", options, async () => {
  const f = await setup();
  try {
    const cookie = await f.login("editor-a", "fixture-password-a");
    assert.equal((await f.post("/api/team/me", {}, cookie, { Origin: "https://untrusted.invalid" })).status, 403);
    assert.equal((await f.post("/api/session/logout", {}, cookie)).status, 200);
    assert.equal((await f.post("/api/team/me", {}, cookie)).status, 401);
    assert.equal((await f.post("/api/team/me")).status, 401);
  } finally { await f.close(); }
});

test("legacy exchange never restores sessions revoked by a password change", options, async () => {
  const f = await setup();
  try {
    const editor = f.users[0];
    const legacy = jwt.sign({ id: editor.id, name: editor.name }, legacyKey, { expiresIn: "1h" });
    const first = await f.post("/api/session/exchange", {}, undefined, { Authorization: `Bearer ${legacy}` });
    assert.equal(first.status, 200);
    assert(first.cookie);
    await updateAccountPassword(f.db, await getTeamUser(f.db, editor.id), { id: editor.id, name: editor.name, password: "new-fixture-password" });
    assert.equal((await f.post("/api/team/me", {}, first.cookie)).status, 401);
    const revoked = await f.post("/api/session/exchange", {}, undefined, { Authorization: `Bearer ${legacy}` });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.body.code, "SESSION_REVOKED");
  } finally { await f.close(); }
});
