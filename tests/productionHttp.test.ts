import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { createProductionHandlers } from "../src/services/productionHttp";
import { productionEvents, type ProductionChange } from "../src/services/productionEvents";
import { createProductionFixture, closeProductionFixture, productionUrl } from "./helpers/productionFixture";

async function fixture() {
  const f = await createProductionFixture();
  await f.db("o_storyboard").insert([
    { id: 101, projectId: 100, scriptId: 10, prompt: "original", videoDesc: "original desc", state: "未生成", index: 0 },
    { id: 201, projectId: 200, scriptId: 20, prompt: "other", videoDesc: "other desc", state: "未生成", index: 0 },
  ]);
  const app = express(); app.use(express.json());
  // Exercise handlers with verified server identity, never an actor from the body.
  const secret = "test-only-ephemeral-session-signing-key";
  app.use((req, _res, next) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (token) { try { (req as any).user = jwt.verify(token, secret); } catch {} }
    next();
  });
  const handlers = createProductionHandlers(f.db, productionUrl);
  for (const [name, handler] of Object.entries(handlers)) app.post(`/api/production/storyboard/${name}`, handler);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  const address = server.address(); assert(address && typeof address !== "string");
  const post = async (name: string, body: object, user: number | null = 7) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/production/storyboard/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(user == null ? {} : { Authorization: `Bearer ${jwt.sign({ id: user }, secret)}` }) }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { ...f, post, close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await closeProductionFixture(f); } };
}

test("HTTP owner authorization, project binding and body actor rejection", async () => {
  const f = await fixture();
  try {
    const body = { projectId: 100, id: 101 };
    assert.equal((await f.post("getState", body, null)).status, 401);
    assert.equal((await f.post("getState", body, 8)).status, 403);
    assert.equal((await f.post("getState", { ...body, id: 201 })).status, 404);
    assert.equal((await f.post("getState", { ...body, actor: { id: 7, kind: "human" } })).status, 400);
    const read = await f.post("getState", body);
    assert.equal(read.status, 200); assert.equal(read.body.data.state.version, 0);
  } finally { await f.close(); }
});

test("HTTP simultaneous edits reject stale version and only successful commit emits change", async () => {
  const f = await fixture(); const changes: ProductionChange[] = [];
  const listener = (change: ProductionChange) => changes.push(change); productionEvents.on("changed", listener);
  try {
    const body = { projectId: 100, id: 101, expectedVersion: 0, prompt: "first", videoDesc: "saved" };
    const results = await Promise.all([f.post("editStoryboardInfo", body), f.post("editStoryboardInfo", { ...body, prompt: "second" })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(changes.length, 1); assert.deepEqual(changes[0], { projectId: 100, scriptId: 10, storyboardId: 101 });
    const state = (await f.post("getState", { projectId: 100, id: 101 })).body.data.state;
    assert.equal(state.version, 1); assert.equal(state.updatedBy, "human:7"); assert.equal("internalMutation" in state, false);
    assert.equal((await f.post("editStoryboardInfo", { projectId: 100, id: 101, prompt: "unversioned", videoDesc: "" })).status, 400);
  } finally { productionEvents.off("changed", listener); await f.close(); }
});

test("HTTP lock protects edits, image replacement and atomic batch deletion", async () => {
  const f = await fixture();
  try {
    const identity = { projectId: 100, id: 101 };
    let result = await f.post("setReviewState", { ...identity, expectedVersion: 0, reviewState: "approved" });
    assert.equal(result.status, 200);
    result = await f.post("setLock", { ...identity, expectedVersion: 1, locked: true });
    assert.equal(result.status, 200); assert.equal(result.body.data.state.lockedBy, "human:7");
    assert.equal((await f.post("editStoryboardInfo", { ...identity, expectedVersion: 2, prompt: "blocked", videoDesc: "" })).status, 423);
    assert.equal((await f.post("updateStoryboardUrl", { ...identity, expectedVersion: 2, url: "/oss/replacement.png", flowId: 1 })).status, 423);
    assert.equal((await f.post("removeFrame", { ...identity, expectedVersion: 2 })).status, 423);
    assert.equal((await f.post("batchDelete", { projectId: 100, ids: [101], expectedVersions: { 101: 2 } })).status, 423);
    assert.equal((await f.db("o_storyboard").where({ id: 101 }).first()).prompt, "original");
    assert.equal((await f.post("setLock", { ...identity, expectedVersion: 1, locked: false })).status, 409);
    assert.equal((await f.post("setLock", { ...identity, expectedVersion: 2, locked: false })).status, 200);
    const edit = await f.post("editStoryboardInfo", { ...identity, expectedVersion: 3, prompt: "revised", videoDesc: "" });
    assert.equal(edit.status, 200); assert.equal(edit.body.data.state.reviewState, "draft");
    assert.equal((await f.post("removeFrame", { ...identity, expectedVersion: 4 })).status, 200);
    assert.equal(await f.db("o_storyboard").where({ id: 101 }).first(), undefined);
  } finally { await f.close(); }
});

test("legacy canvas deletion endpoints refuse linked tracks without the new track CAS and idempotency contract", async () => {
  const f = await fixture();
  try {
    const [track] = await f.db("o_videoTrack").insert({ projectId: 100, scriptId: 10, duration: 2 }).returning("id");
    await f.db("o_storyboard").where({ id: 101 }).update({ trackId: Number(track.id) });
    const state = await f.db("ext_entity_state").where({ projectId: 100, entityType: "storyboard", entityId: 101 }).first();
    const expectedVersion = Number(state?.version ?? 0);
    assert.equal((await f.post("removeFrame", { projectId: 100, id: 101, expectedVersion })).status, 409);
    assert.equal((await f.post("batchDelete", { projectId: 100, ids: [101], expectedVersions: { 101: expectedVersion } })).status, 409);
    assert.ok(await f.db("o_storyboard").where({ id: 101 }).first());
    assert.ok(await f.db("o_videoTrack").where({ id: Number(track.id) }).first());
  } finally { await f.close(); }
});
