import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createBatchDeleteStoryboardTracksRouter, createDeleteStoryboardTrackRouter } from "../src/services/trackWorkspace/deleteStoryboardHttp";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { associateProjectWithTeam, ensureTeamSchema, issueTeamSession, teamAuthMiddleware } from "../src/services/team";
import { authorizeRoute } from "../src/services/team/authorization";
import { ensureTrackWorkspaceSchema } from "../src/services/trackWorkspace";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };

test("HTTP middleware lets the same actor replay a deleted storyboard receipt while cross actor/project/key requests still fail", options, async () => {
  const fixture = await createPostgresFixture();
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    await migratePostgresFixture(fixture.db); await ensureTeamSchema(fixture.db, { bootstrapAdminUserId: 1 }); await ensureTrackWorkspaceSchema(fixture.db);
    await fixture.db("o_user").insert({ id: 2, name: "other-admin", password: "unused" }); await fixture.db("team_users").insert({ user_id: 2, role: "admin", enabled: true, version: 1, session_revision: 0 });
    const [project] = await fixture.db("o_project").insert({ userId: 1, name: "delete HTTP" }).returning("id"), projectId = Number(project.id); await associateProjectWithTeam(fixture.db, projectId);
    const [otherProject] = await fixture.db("o_project").insert({ userId: 1, name: "other HTTP" }).returning("id"), otherProjectId = Number(otherProject.id); await associateProjectWithTeam(fixture.db, otherProjectId);
    const [script] = await fixture.db("o_script").insert({ projectId, name: "episode" }).returning("id"), scriptId = Number(script.id);
    const [otherScript] = await fixture.db("o_script").insert({ projectId: otherProjectId, name: "other" }).returning("id"), otherScriptId = Number(otherScript.id);
    const [track] = await fixture.db("o_videoTrack").insert({ projectId, scriptId, duration: 2 }).returning("id"), trackId = Number(track.id);
    const [board] = await fixture.db("o_storyboard").insert({ projectId, scriptId, trackId, duration: "2", prompt: "shot" }).returning("id"), storyboardId = Number(board.id);
    const boardVersion = Number((await fixture.db("ext_entity_state").where({ projectId, entityType: "storyboard", entityId: storyboardId }).first())?.version ?? 0);
    const [otherTrack] = await fixture.db("o_videoTrack").insert({ projectId: otherProjectId, scriptId: otherScriptId, duration: 2 }).returning("id");
    const app = express(); app.use(express.json()); app.use(teamAuthMiddleware(fixture.db, { requireOrigin: false })); app.use(async (req, res, next) => { try { const principal = (req as any).teamPrincipal; (req as any).user = principal; await authorizeRoute({ db: fixture.db }, req.method, req.originalUrl.split("?")[0].replace(/\/$/, ""), principal, req); next(); } catch (error) { const value = error as any; res.status(value.status ?? 403).send({ code: value.code ?? "FORBIDDEN", message: value.message ?? "拒绝" }); } }); app.use("/api/production/workbench/deleteStoryboardTrack", createDeleteStoryboardTrackRouter(fixture.db));
    const running = await new Promise<any>((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); }); server = running; const address = running.address(); assert(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
    const firstSession = await issueTeamSession(fixture.db, 1, { secureCookie: false }), secondSession = await issueTeamSession(fixture.db, 2, { secureCookie: false });
    const post = async (body: any, cookie: string) => { const response = await fetch(`${base}/api/production/workbench/deleteStoryboardTrack`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as any }; };
    const body = { projectId, scriptId, trackId, storyboardId, expectedTrackVersion: 0, expectedStoryboardVersion: boardVersion, idempotencyKey: "http-delete-replay" };
    const first = await post(body, firstSession.cookie); assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.data.reused, false);
    const replay = await post(body, firstSession.cookie); assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.data.reused, true);
    assert.equal((await post({ ...body, idempotencyKey: "http-delete-new-key" }, firstSession.cookie)).status, 403);
    assert.equal((await post(body, secondSession.cookie)).status, 403);
    assert.equal((await post({ ...body, projectId: otherProjectId, scriptId: otherScriptId, trackId: Number(otherTrack.id) }, firstSession.cookie)).status, 403);
  } finally { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); await fixture.destroy(); }
});

test("canvas batch deletion is atomic and its receipt replays through real authorization after every resource is gone", options, async () => {
  const fixture = await createPostgresFixture();
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    await migratePostgresFixture(fixture.db); await ensureTeamSchema(fixture.db, { bootstrapAdminUserId: 1 }); await ensureTrackWorkspaceSchema(fixture.db);
    await fixture.db("o_user").insert({ id: 2, name: "other-admin", password: "unused" }); await fixture.db("team_users").insert({ user_id: 2, role: "admin", enabled: true, version: 1, session_revision: 0 });
    const [project] = await fixture.db("o_project").insert({ userId: 1, name: "batch HTTP" }).returning("id"), projectId = Number(project.id); await associateProjectWithTeam(fixture.db, projectId);
    const [otherProject] = await fixture.db("o_project").insert({ userId: 1, name: "other batch HTTP" }).returning("id"), otherProjectId = Number(otherProject.id); await associateProjectWithTeam(fixture.db, otherProjectId);
    const [script] = await fixture.db("o_script").insert({ projectId, name: "episode" }).returning("id"), scriptId = Number(script.id);
    const [track] = await fixture.db("o_videoTrack").insert({ projectId, scriptId, duration: 2 }).returning("id"), trackId = Number(track.id);
    const [linked] = await fixture.db("o_storyboard").insert({ projectId, scriptId, trackId, duration: "2", prompt: "linked" }).returning("id");
    const [orphan] = await fixture.db("o_storyboard").insert({ projectId, scriptId, trackId: null, duration: "1", prompt: "orphan" }).returning("id");
    const items = [
      { scriptId, storyboardId: Number(linked.id), trackId, expectedTrackVersion: 0, expectedStoryboardVersion: 0 },
      { scriptId, storyboardId: Number(orphan.id), trackId: null, expectedTrackVersion: null, expectedStoryboardVersion: 0 },
    ];
    const app = express(); app.use(express.json()); app.use(teamAuthMiddleware(fixture.db, { requireOrigin: false })); app.use(async (req, res, next) => { try { const principal = (req as any).teamPrincipal; (req as any).user = principal; await authorizeRoute({ db: fixture.db }, req.method, req.originalUrl.split("?")[0].replace(/\/$/, ""), principal, req); next(); } catch (error) { const value = error as any; res.status(value.status ?? 403).send({ code: value.code ?? "FORBIDDEN", message: value.message ?? "拒绝" }); } }); app.use("/api/production/storyboard/deleteStoryboardTracks", createBatchDeleteStoryboardTracksRouter(fixture.db));
    const running = await new Promise<any>((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); }); server = running; const address = running.address(); assert(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
    const firstSession = await issueTeamSession(fixture.db, 1, { secureCookie: false }), secondSession = await issueTeamSession(fixture.db, 2, { secureCookie: false });
    const post = async (body: any, cookie: string) => { const response = await fetch(`${base}/api/production/storyboard/deleteStoryboardTracks`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as any }; };
    const body = { projectId, items, idempotencyKey: "canvas-batch-replay" };
    const first = await post(body, firstSession.cookie); assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.data.deletedStoryboardCount, 2); assert.equal(first.body.data.reused, false);
    const replay = await post({ ...body, items: [...items].reverse() }, firstSession.cookie); assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.data.reused, true);
    assert.equal((await post({ ...body, idempotencyKey: "canvas-batch-new-key" }, firstSession.cookie)).status, 403);
    assert.equal((await post(body, secondSession.cookie)).status, 403);
    assert.equal((await post({ ...body, projectId: otherProjectId }, firstSession.cookie)).status, 403);
  } finally { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); await fixture.destroy(); }
});
