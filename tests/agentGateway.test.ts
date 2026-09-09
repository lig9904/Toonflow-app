import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  createAgentGateway,
  ensureAgentGatewaySchema,
  agentGatewayConfigFromEnv,
} from "../src/services/agentGateway";
import { ProductionStateService } from "../src/services/productionState";
import {
  createProductionFixture,
  closeProductionFixture,
  productionUrl,
} from "./helpers/productionFixture";

const token = "test-token-for-scoped-agent-gateway-12345";
async function fixture(allowWrite = false, enabled = true) {
  const f = await createProductionFixture();
  await f.db.schema.alterTable("o_project", (t) => {
    t.text("name");
    t.text("intro");
    t.text("projectType");
  });
  await f.db.schema.alterTable("o_script", (t) => {
    t.text("name");
    t.integer("createTime");
  });
  await f.db.schema.createTable("o_video", (t) => {
    t.integer("id").primary();
    t.integer("projectId");
    t.integer("scriptId");
    t.integer("videoTrackId");
    t.text("state");
    t.integer("time");
  });
  await f
    .db("o_storyboard")
    .insert({
      id: 101,
      projectId: 100,
      scriptId: 10,
      prompt: "original",
      videoDesc: "description",
      state: "未生成",
    });
  await ensureAgentGatewaySchema(f.db);
  const app = express();
  app.use(express.json());
  app.use(
    "/api/agent",
    createAgentGateway(
      f.db,
      enabled
        ? {
            token,
            userId: 7,
            projectIds: [100],
            allowStoryboardWrite: allowWrite,
          }
        : null,
      productionUrl,
    ),
  );
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  assert(addr && typeof addr !== "string");
  const baseUrl = `http://127.0.0.1:${addr.port}/api/agent`;
  const post = async (
    path: string,
    data: unknown,
    credential: string | null = token,
  ) => {
    const r = await fetch(`${baseUrl}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify(data),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  return {
    ...f,
    baseUrl,
    post,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await closeProductionFixture(f);
    },
  };
}

test("agent configuration fails closed for incomplete or malformed scope", async () => {
  assert.equal(agentGatewayConfigFromEnv({}), null);
  assert.equal(
    agentGatewayConfigFromEnv({
      TOONFLOW_AGENT_TOKEN: token,
      TOONFLOW_AGENT_USER_ID: "7",
      TOONFLOW_AGENT_PROJECT_IDS: "",
    }),
    null,
  );
  const f = await fixture(false, false);
  try {
    assert.equal((await f.post("projects", {})).status, 503);
  } finally {
    await f.close();
  }
});
test("agent credential is independent and scope checks happen for every request", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post("projects", {}, null)).status, 401);
    assert.equal((await f.post("projects", {}, "wrong")).status, 401);
    assert.equal(
      (await f.post(`projects?token=${token}`, {}, null)).status,
      401,
    );
    const projects = await f.post("projects", {});
    assert.equal(projects.status, 200);
    assert.deepEqual(
      projects.body.data.map((p: any) => p.id),
      [100],
    );
    assert.equal(JSON.stringify(projects.body).includes("password"), false);
    assert.equal(
      (await f.post("flow", { projectId: 200, scriptId: 20 })).status,
      403,
    );
    assert.equal(
      (await f.post("flow", { projectId: 100, scriptId: 20 })).status,
      404,
    );
    assert.equal(
      (
        await f.post("storyboard", {
          projectId: 100,
          storyboardId: 101,
          actor: { kind: "human" },
        })
      ).status,
      400,
    );
    assert.equal((await f.post("storyboard/approve", {})).status, 404);
    await f.db("o_project").where({ id: 100 }).update({ userId: 8 });
    assert.equal(
      (await f.post("storyboard", { projectId: 100, storyboardId: 101 }))
        .status,
      403,
    );
  } finally {
    await f.close();
  }
});
test("agent writes require explicit capability, an observed version, and durable idempotency", async () => {
  const data = {
    projectId: 100,
    storyboardId: 101,
    expectedVersion: 0,
    prompt: "changed",
    videoDesc: "description",
    reason: "requested revision",
    idempotencyKey: "request-1234567890",
  };
  const ro = await fixture();
  try {
    assert.equal((await ro.post("storyboard/update", data)).status, 403);
  } finally {
    await ro.close();
  }
  const f = await fixture(true);
  try {
    const first = await f.post("storyboard/update", data);
    assert.equal(first.status, 200);
    assert.equal(first.body.data.state.version, 1);
    assert.equal(first.body.data.state.updatedBy, "agent:owner:7");
    const replay = await f.post("storyboard/update", data);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.replayed, true);
    assert.equal(
      (await f.post("storyboard/update", { ...data, prompt: "different" }))
        .status,
      409,
    );
    assert.equal(
      (
        await f.post("storyboard/update", {
          ...data,
          idempotencyKey: "different-request-123",
        })
      ).status,
      409,
    );
    const audit = await f.db("ext_agent_mutations");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].reason, "requested revision");
    assert.equal(audit[0].result.includes(token), false);
    await new ProductionStateService(f.db).acquireLock({
      projectId: 100,
      storyboardId: 101,
      expectedVersion: 1,
      actor: { id: "human:7", kind: "human" },
    });
    assert.equal(
      (
        await f.post("storyboard/update", {
          ...data,
          expectedVersion: 2,
          idempotencyKey: "locked-write-12345",
        })
      ).status,
      423,
    );
    assert.equal((await f.db("ext_agent_mutations")).length, 1);
  } finally {
    await f.close();
  }
});
