import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureCreativeWorkspaceSchema } from "../src/services/creativeWorkspace";
import { ensureProductionStateSchema } from "../src/services/productionState";
import { ensureVolcengineReferenceSchema, readBoundVolcengineReferences, readVolcengineBindingSnapshots, readVolcengineReferenceBindings, replaceVolcengineReferenceBindings, resolveCurrentVolcengineReference, syncVolcengineReferenceBindings, VolcengineTrustedAssetClient } from "../src/services/volcengineTrustedAssets";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function remoteFetch(state: { status: "Active" | "Processing" | "Failed"; calls: Array<{ action: string; body: any; authorization: string }> }) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), action = url.searchParams.get("Action") ?? "", body = JSON.parse(String(init?.body ?? "{}"));
    state.calls.push({ action, body, authorization: String(new Headers(init?.headers).get("authorization") ?? "") });
    if (action === "ListAssetGroups") return response({ Result: { Items: [{ Id: "group-human-1", Name: "演员甲", Description: "已授权真人", GroupType: "LivenessFace", ProjectName: "default", CreateTime: "2026-09-01T00:00:00Z", UpdateTime: "2026-09-02T00:00:00Z" }], NextToken: "next-group" } });
    if (action === "ListAssets") return response({ Result: { Items: [{ Id: "asset-human-1", GroupId: "group-human-1", Name: "演员甲正面", AssetType: "Image", Status: state.status, ProjectName: "default", URL: "https://temporary.example.test/preview.png?token=short", Moderation: { Strategy: "Default" } }], NextToken: "next-asset" } });
    if (action === "GetAssetGroup") return response({ Result: { Id: body.Id, Name: "演员甲", Description: "已授权真人", GroupType: "LivenessFace", ProjectName: body.ProjectName, UpdateTime: "2026-09-02T00:00:00Z" } });
    if (action === "GetAsset") return response({ Result: { Id: body.Id, GroupId: "group-human-1", Name: "演员甲正面", AssetType: "Image", Status: state.status, ProjectName: body.ProjectName, URL: "https://temporary.example.test/preview.png?token=short", UpdateTime: "2026-09-03T00:00:00Z" } });
    return response({ ResponseMetadata: { Error: { Code: "UnknownAction", Message: "unsupported" } } }, 400);
  };
}

test("official read-only asset APIs use AK signing, cursor pagination and allowlisted views", async () => {
  const state = { status: "Active" as const, calls: [] as Array<{ action: string; body: any; authorization: string }> };
  const client = new VolcengineTrustedAssetClient({ credentials: { accessKeyId: "AKTESTONLY123", secretAccessKey: "SKTESTONLY456" }, fetch: remoteFetch(state), now: () => new Date("2026-09-11T00:00:00Z") });
  const groups = await client.listGroups({ groupType: "LivenessFace", projectName: "default", maxResults: 25 });
  assert.equal(groups.items[0].groupType, "LivenessFace"); assert.equal(groups.nextToken, "next-group");
  const assets = await client.listAssets({ groupType: "LivenessFace", projectName: "default", statuses: ["Active"], nextToken: "cursor", maxResults: 25 });
  assert.equal(assets.items[0].assetUri, "asset://asset-human-1"); assert.match(assets.items[0].previewUrl!, /^https:/); assert.equal(assets.nextToken, "next-asset");
  assert.deepEqual(state.calls.map((item) => item.action), ["ListAssetGroups", "ListAssets"]);
  assert.deepEqual(state.calls[1].body.Filter, { GroupType: "LivenessFace", Statuses: ["Active"] });
  assert.equal(state.calls[1].body.NextToken, "cursor");
  assert.match(state.calls[0].authorization, /^HMAC-SHA256 Credential=AKTESTONLY123\//);
});

test("binding is independently versioned, idempotent, source-bound and exposes only current Active asset URIs", options, async () => {
  const f = await createPostgresFixture();
  try {
    await migratePostgresFixture(f.db); await ensureCreativeWorkspaceSchema(f.db); await ensureProductionStateSchema(f.db); await ensureVolcengineReferenceSchema(f.db);
    const [projectId] = await insertRowsReturningIds(f.db, "o_project", { userId: 1, name: "trusted assets" });
    const [scriptId] = await insertRowsReturningIds(f.db, "o_script", { projectId, name: "episode", content: "scene" });
    const [imageId] = await insertRowsReturningIds(f.db, "o_image", { filePath: "/trusted/local.png", type: "role", state: "已完成" });
    const [assetId] = await insertRowsReturningIds(f.db, "o_assets", { projectId, name: "local actor", type: "role", imageId });
    await f.db("o_scriptAssets").insert({ scriptId, assetId });
    const state = { status: "Active" as "Active" | "Processing" | "Failed", calls: [] as Array<{ action: string; body: any; authorization: string }> };
    const client = new VolcengineTrustedAssetClient({ credentials: { accessKeyId: "AKTESTONLY123", secretAccessKey: "SKTESTONLY456" }, fetch: remoteFetch(state) });
    const input = { projectId, scriptId, targetKind: "asset" as const, targetId: assetId, expectedVersion: 0, expectedSourceVersion: 0, expectedSourceFileHash: "a".repeat(64), idempotencyKey: "trusted-bind-one", items: [{ remoteProjectName: "default", groupType: "LivenessFace" as const, groupId: "group-human-1", assetId: "asset-human-1", assetType: "Image" as const }] };
    const hashSource = async () => "a".repeat(64);
    const saved = await replaceVolcengineReferenceBindings(f.db, client, input, "human:1", hashSource);
    assert.equal(saved.version, 1); assert.equal(saved.sourceFileHash, "a".repeat(64)); assert.equal(saved.items[0].assetUri, "asset://asset-human-1");
    const remoteCalls = state.calls.length;
    const replay = await replaceVolcengineReferenceBindings(f.db, client, input, "human:1", hashSource);
    assert.equal(replay.reused, true); assert.equal(state.calls.length, remoteCalls, "idempotent replay must not call the remote API again");
    const usable = await readBoundVolcengineReferences(f.db, { projectId, scriptId, targetKind: "asset", targetId: assetId });
    assert.equal(usable.sourceCurrent, true); assert.equal(usable.bindingState, "active"); assert.deepEqual(usable.references.map((item) => item.url), ["asset://asset-human-1"]);
    const [unboundAssetId] = await insertRowsReturningIds(f.db, "o_assets", { projectId, name: "unbound", type: "role" });
    await f.db("o_scriptAssets").insert({ scriptId, assetId: unboundAssetId });
    const snapshots = await readVolcengineBindingSnapshots(f.db, { projectId, scriptId, refs: [{ id: unboundAssetId, sources: "assets" }, { id: assetId, sources: "assets" }] }, hashSource);
    assert.equal(snapshots.length, 1); assert.equal(snapshots[0].inputIndex, 1); assert.equal(snapshots[0].sourceFileHash, "a".repeat(64));
    const resolved = await resolveCurrentVolcengineReference(f.db, client, { projectId, scriptId, targetKind: "asset", targetId: assetId }, snapshots[0], hashSource);
    assert.equal(resolved?.url, "asset://asset-human-1");
    assert.equal(Object.hasOwn(await f.db("ext_volcengine_references").first(), "previewUrl"), false, "12-hour preview URLs are not persisted");
    state.status = "Failed"; await syncVolcengineReferenceBindings(f.db, client, { projectId, scriptId, targetKind: "asset", targetId: assetId });
    assert.equal((await readBoundVolcengineReferences(f.db, { projectId, scriptId, targetKind: "asset", targetId: assetId })).references.length, 0);
    await f.db("ext_creative_state").insert({ entityType: "asset", entityId: assetId, projectId, version: 1, updatedBy: "human:2", updatedAt: Date.now() }).onConflict(["entityType", "entityId"]).merge();
    await f.db("o_image").where({ id: imageId }).update({ filePath: null });
    const stale = await readVolcengineReferenceBindings(f.db, { projectId, scriptId, targetKind: "asset", targetId: assetId });
    assert.equal(stale.sourceCurrent, false); assert.equal(stale.currentSourceFileHash, null); assert.equal((await readBoundVolcengineReferences(f.db, { projectId, scriptId, targetKind: "asset", targetId: assetId })).bindingState, "stale");
    await assert.rejects(resolveCurrentVolcengineReference(f.db, client, { projectId, scriptId, targetKind: "asset", targetId: assetId }, snapshots[0], hashSource), (error: any) => error.code === "STALE_BINDING");
    const cleared = await replaceVolcengineReferenceBindings(f.db, undefined, { ...input, expectedVersion: 1, expectedSourceVersion: 1, expectedSourceFileHash: null, idempotencyKey: "trusted-bind-clear", items: [] }, "human:1", hashSource);
    assert.equal(cleared.version, 2); assert.equal(cleared.items.length, 0);
    const clearReplay = await replaceVolcengineReferenceBindings(f.db, undefined, { ...input, expectedVersion: 1, expectedSourceVersion: 1, expectedSourceFileHash: null, idempotencyKey: "trusted-bind-clear", items: [] }, "human:1", async () => { throw new Error("idempotent replay must not read a removed file"); });
    assert.equal(clearReplay.reused, true);
  } finally { await f.destroy(); }
});


test("official error envelopes remain readable without exposing keys or delivery URLs", async () => {
  for (const status of [200, 400, 408, 503]) {
    const client = new VolcengineTrustedAssetClient({ credentials: { accessKeyId: "AKTESTONLY123", secretAccessKey: "private-secret-value" }, fetch: async () => response({ ResponseMetadata: { Error: { Code: "AccountRequired", Message: "private-secret-value https://media.example.test/media-bridge/private-token" } } }, status) });
    await assert.rejects(client.listGroups({ groupType: "AIGC", projectName: "default" }), (error: any) =>
      error.code === ([200, 400].includes(status) ? "UPSTREAM_REJECTED" : "UPSTREAM_FAILED") && /AccountRequired/.test(error.message) && !/private-secret-value|private-token/.test(error.message));
  }
});
