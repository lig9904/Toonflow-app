import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createPostgresFixture } from "../src/lib/postgresTest";
import { ensureTeamSchema, issueTeamSession } from "../src/services/team";
import { createScriptAgentSocketRoute } from "../src/socket/routes/scriptAgent";
import { createProductionAgentSocketRoute } from "../src/socket/routes/productionAgent";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };

class FakeSocket extends EventEmitter {
  readonly emitted: Array<{ event: string; data: unknown }> = [];
  disconnected = false;
  handshake: { headers: Record<string, string>; auth: Record<string, unknown> };
  constructor(cookie: string, auth: Record<string, unknown>, origin = "http://localhost") {
    super();
    this.handshake = { headers: { cookie, origin, host: "localhost" }, auth };
  }
  override emit(event: string, ...args: unknown[]): boolean {
    if (event !== "connection" && event !== "disconnect") this.emitted.push({ event, data: args[0] });
    return super.emit(event, ...args);
  }
  disconnect(): void { this.disconnected = true; super.emit("disconnect"); }
}

class FakeNamespace extends EventEmitter {
  connect(socket: FakeSocket): void { this.emit("connection", socket); }
}

async function fixture() {
  const f = await createPostgresFixture();
  await f.db.schema.createTable("o_user", (table) => { table.integer("id").primary(); table.text("name").notNullable(); });
  await f.db.schema.createTable("o_project", (table) => { table.integer("id").primary(); table.integer("userId").notNullable(); });
  await f.db.schema.createTable("o_script", (table) => { table.integer("id").primary(); table.integer("projectId").notNullable(); });
  await f.db("o_user").insert([{ id: 1, name: "editor" }, { id: 2, name: "viewer" }]);
  await f.db("o_project").insert([{ id: 10, userId: 1 }, { id: 20, userId: 1 }]);
  await f.db("o_script").insert([{ id: 100, projectId: 10 }, { id: 200, projectId: 20 }]);
  await ensureTeamSchema(f.db, { bootstrapAdminUserId: 1 });
  await f.db("team_users").where({ user_id: 2 }).update({ role: "viewer" });
  const editor = await issueTeamSession(f.db, 1);
  const viewer = await issueTeamSession(f.db, 2);
  return { ...f, editor, viewer };
}

function runtimeStub() {
  const calls: Array<Record<string, unknown>> = [];
  const controls: unknown[] = [];
  let runCount = 0;
  return {
    calls, controls,
    runtime: {
      create: async (input: Record<string, unknown>) => { calls.push(input); runCount += 1; return { reused: runCount > 1, run: { id: "00000000-0000-4000-8000-000000000001" } }; },
      control: async (...args: unknown[]) => { controls.push(args); return {}; },
    } as any,
  };
}

test("script socket uses HttpOnly cookie, origin, edit access and idempotent run creation", options, async () => {
  const f = await fixture();
  try {
    const stub = runtimeStub();
    const namespace = new FakeNamespace();
    createScriptAgentSocketRoute({ db: f.db, runtime: stub.runtime })(namespace as any);
    const socket = new FakeSocket(f.editor.cookie.split(";")[0], { projectId: 10, scriptId: 100 });
    namespace.connect(socket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const replies: unknown[] = [];
    socket.emit("chat", { content: "make a script", idempotencyKey: "socket-chat-1" }, (reply: unknown) => replies.push(reply));
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.emit("chat", { content: "make a script", idempotencyKey: "socket-chat-1" }, (reply: unknown) => replies.push(reply));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].requestedBy, 1);
    assert.equal(stub.calls[0].projectId, 10);
    assert.equal(stub.calls[0].scriptId, 100);
    assert.deepEqual(replies, [{ success: true, runId: "00000000-0000-4000-8000-000000000001", reused: false }, { success: true, runId: "00000000-0000-4000-8000-000000000001", reused: true }]);
    assert.equal(socket.emitted.filter((item) => item.event === "builtinRunCreated").length, 2);
    socket.emit("disconnect");
    assert.equal(stub.controls.length, 0);
  } finally { await f.destroy(); }
});

test("viewer can connect/read but cannot create an editing chat", options, async () => {
  const f = await fixture();
  try {
    const stub = runtimeStub();
    const namespace = new FakeNamespace();
    createProductionAgentSocketRoute({ db: f.db, runtime: stub.runtime })(namespace as any);
    const socket = new FakeSocket(f.viewer.cookie.split(";")[0], { projectId: 10, scriptId: 100 });
    namespace.connect(socket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    let reply: unknown;
    socket.emit("chat", { content: "edit production", idempotencyKey: "viewer-chat-1" }, (value: unknown) => { reply = value; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stub.calls.length, 0);
    assert.equal((reply as { success: boolean }).success, false);
  } finally { await f.destroy(); }
});

test("production context switching validates project and episode together and ignores client isolationKey", options, async () => {
  const f = await fixture();
  try {
    const stub = runtimeStub();
    const namespace = new FakeNamespace();
    createProductionAgentSocketRoute({ db: f.db, runtime: stub.runtime })(namespace as any);
    const socket = new FakeSocket(f.editor.cookie.split(";")[0], { projectId: 10, scriptId: 100 });
    namespace.connect(socket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    let denied: unknown;
    socket.emit("updateContext", { projectId: 10, scriptId: 200, isolationKey: "attacker" }, (value: unknown) => { denied = value; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((denied as { success: boolean }).success, false);
    let accepted: unknown;
    socket.emit("updateContext", { projectId: 20, scriptId: 200, isolationKey: "attacker" }, (value: unknown) => { accepted = value; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(accepted, { success: true, isolationKey: "20:productionAgent:200" });
  } finally { await f.destroy(); }
});

test("bearer-only and missing-origin handshakes are rejected", options, async () => {
  const f = await fixture();
  try {
    const stub = runtimeStub();
    const namespace = new FakeNamespace();
    createScriptAgentSocketRoute({ db: f.db, runtime: stub.runtime })(namespace as any);
    const bearer = new FakeSocket("", { token: `Bearer ${f.editor.token}`, projectId: 10, scriptId: 100 });
    namespace.connect(bearer);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bearer.disconnected, true);
    const noOrigin = new FakeSocket(f.editor.cookie.split(";")[0], { projectId: 10, scriptId: 100 }, "");
    namespace.connect(noOrigin);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(noOrigin.disconnected, true);
  } finally { await f.destroy(); }
});
