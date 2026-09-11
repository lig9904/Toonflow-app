import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureCreativeWorkspaceSchema } from "../src/services/creativeWorkspace";
import { ensureProductionStateSchema } from "../src/services/productionState";
import { VolcengineTrustedAssetClient } from "../src/services/volcengineTrustedAssets";
import { ensureVolcengineAssetUploadSchema, getVolcengineAssetGroupCreation, getVolcengineAssetUpload, startVolcengineAssetGroupCreation, startVolcengineAssetUpload, type VolcengineAssetUploadRuntime } from "../src/services/volcengineTrustedAssetUploads";
import { createVolcengineTrustedAssetUploadRecovery } from "../src/services/volcengineTrustedAssetUploadRecovery";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function clientFor(handler: (action: string, body: any) => Promise<Response> | Response) {
  return new VolcengineTrustedAssetClient({ credentials: { accessKeyId: "AKTESTONLY123", secretAccessKey: "SKTESTONLY456" }, fetch: async (input, init) => handler(new URL(String(input)).searchParams.get("Action") ?? "", JSON.parse(String(init?.body ?? "{}"))) });
}

test("background recovery completes upload-and-bind after the UI closes and never sends Create again", options, async () => {
  const fixture = await createPostgresFixture();
  try {
    await migratePostgresFixture(fixture.db); await ensureCreativeWorkspaceSchema(fixture.db); await ensureProductionStateSchema(fixture.db);
    const [projectId] = await insertRowsReturningIds(fixture.db, "o_project", { userId: 1, name: "recover upload" });
    const [scriptId] = await insertRowsReturningIds(fixture.db, "o_script", { projectId, name: "episode", content: "scene" });
    const [imageId] = await insertRowsReturningIds(fixture.db, "o_image", { filePath: "/recover/virtual.png", type: "role", state: "已完成" });
    const [assetId] = await insertRowsReturningIds(fixture.db, "o_assets", { projectId, name: "virtual", type: "role", imageId });
    await fixture.db("o_image").where({ id: imageId }).update({ assetsId: assetId }); await fixture.db("o_scriptAssets").insert({ scriptId, assetId });
    const hash = "a".repeat(64);
    const runtime: VolcengineAssetUploadRuntime = { hashSource: async () => hash, prepareSource: async () => ({ sourceVersion: 0, sourceFilePath: "/recover/virtual.png", sourceFileHash: hash, mediaType: "Image", leaseUrl: "https://media.example.test/media-bridge/token", leaseId: "lease", contentHash: "b".repeat(64), sizeBytes: 500_000, mtimeMs: 1, expiresAt: Date.now() + 60_000 }) };
    let createCount = 0;
    const startClient = clientFor((action, body) => {
      if (action === "GetAssetGroup") return response({ Result: { Id: body.Id, Name: "virtual", GroupType: "AIGC", ProjectName: "default" } });
      if (action === "CreateAsset") { createCount += 1; return response({ Result: { Id: "asset-background" } }); }
      throw new Error(`unexpected ${action}`);
    });
    const started = await startVolcengineAssetUpload(fixture.db, startClient, { projectId, scriptId, targetKind: "asset", targetId: assetId, remoteProjectName: "default", groupId: "group-aigc", groupType: "AIGC", name: "虚拟角色", assetType: "Image", mode: "uploadAndBind", expectedSourceVersion: 0, expectedSourceFileHash: hash, expectedBindingVersion: 0, idempotencyKey: "background-upload-bind" }, "human:7", runtime);
    assert.equal(started.status, "processing"); assert.equal(createCount, 1);
    const calls: string[] = [], recoveryClient = clientFor(async (action, body) => {
      calls.push(action); await new Promise((resolve) => setTimeout(resolve, 5));
      if (action === "GetAsset") return response({ Result: { Id: body.Id, GroupId: "group-aigc", Name: "virtual", AssetType: "Image", Status: "Active", ProjectName: "default" } });
      if (action === "GetAssetGroup") return response({ Result: { Id: body.Id, Name: "virtual", GroupType: "AIGC", ProjectName: "default" } });
      throw new Error(`Create must not be called during recovery: ${action}`);
    });
    const auth: Array<{ actorId: string; projectId: number }> = [];
    const dependencies = { db: fixture.db, client: async () => recoveryClient, runtime: () => runtime, authorize: async (request: any) => { auth.push(request); return true; } };
    const first = createVolcengineTrustedAssetUploadRecovery(dependencies), second = createVolcengineTrustedAssetUploadRecovery(dependencies);
    await Promise.all([first.runOnce(), first.runOnce(), second.runOnce()]);
    const completed = await getVolcengineAssetUpload(fixture.db, { projectId, operationId: started.operationId });
    assert.equal(completed.status, "active"); assert.equal(completed.bindStatus, "bound"); assert.equal(createCount, 1); assert.deepEqual(auth.map((item) => item.actorId), ["human:7"]);
    const callCount = calls.length;
    await createVolcengineTrustedAssetUploadRecovery(dependencies).runOnce();
    assert.equal(calls.length, callCount, "restart must ignore a terminal persisted operation");
  } finally { await fixture.destroy(); }
});

test("unknown recovery uses trace lookup, applies backoff, and stops when original edit permission is lost", options, async () => {
  const fixture = await createPostgresFixture();
  try {
    await migratePostgresFixture(fixture.db); await ensureCreativeWorkspaceSchema(fixture.db); await ensureProductionStateSchema(fixture.db);
    const [projectId] = await insertRowsReturningIds(fixture.db, "o_project", { userId: 1, name: "recover unknown" });
    const [scriptId] = await insertRowsReturningIds(fixture.db, "o_script", { projectId, name: "episode", content: "scene" });
    const [imageId] = await insertRowsReturningIds(fixture.db, "o_image", { filePath: "/recover/unknown.png", type: "role", state: "已完成" });
    const [assetId] = await insertRowsReturningIds(fixture.db, "o_assets", { projectId, name: "virtual", type: "role", imageId });
    await fixture.db("o_image").where({ id: imageId }).update({ assetsId: assetId }); await fixture.db("o_scriptAssets").insert({ scriptId, assetId });
    const hash = "c".repeat(64), runtime: VolcengineAssetUploadRuntime = { hashSource: async () => hash, prepareSource: async () => ({ sourceVersion: 0, sourceFilePath: "/recover/unknown.png", sourceFileHash: hash, mediaType: "Image", leaseUrl: "https://media.example.test/media-bridge/token", leaseId: "lease", contentHash: "d".repeat(64), sizeBytes: 400_000, mtimeMs: 1, expiresAt: Date.now() + 60_000 }) };
    const unknownClient = clientFor((action, body) => {
      if (action === "GetAssetGroup") return response({ Result: { Id: body.Id, Name: "virtual", GroupType: "AIGC", ProjectName: "default" } });
      if (action === "CreateAsset" || action === "CreateAssetGroup") throw new Error("network outcome unknown");
      throw new Error(`unexpected ${action}`);
    });
    const upload = await startVolcengineAssetUpload(fixture.db, unknownClient, { projectId, scriptId, targetKind: "asset", targetId: assetId, remoteProjectName: "default", groupId: "group-aigc", groupType: "AIGC", assetType: "Image", mode: "uploadOnly", expectedSourceVersion: 0, expectedSourceFileHash: hash, expectedBindingVersion: null, idempotencyKey: "background-unknown-upload" }, "human:8", runtime);
    const group = await startVolcengineAssetGroupCreation(fixture.db, unknownClient, { projectId, remoteProjectName: "default", name: "虚拟组", groupType: "AIGC", idempotencyKey: "background-unknown-group" }, "human:8");
    const calls: string[] = [], recoveryClient = clientFor((action, body) => {
      calls.push(action);
      if (action === "ListAssets") return response({ Result: { Items: [{ Id: "asset-recovered", GroupId: "group-aigc", Name: body.Filter.Name, AssetType: "Image", Status: "Active", ProjectName: "default" }] } });
      if (action === "GetAsset") return response({ Result: { Id: body.Id, GroupId: "group-aigc", Name: "virtual", AssetType: "Image", Status: "Active", ProjectName: "default" } });
      if (action === "ListAssetGroups") return response({ Result: { Items: [{ Id: "group-recovered", Name: body.Filter.Name, GroupType: "AIGC", ProjectName: "default" }] } });
      throw new Error(`Create must not be called during recovery: ${action}`);
    });
    const runner = createVolcengineTrustedAssetUploadRecovery({ db: fixture.db, client: async () => recoveryClient, runtime: () => runtime, authorize: async () => true });
    await runner.runOnce();
    assert.equal((await getVolcengineAssetUpload(fixture.db, { projectId, operationId: upload.operationId })).status, "active");
    assert.deepEqual([...new Set(calls)].sort(), ["GetAsset", "ListAssetGroups", "ListAssets"]); assert.equal(calls.some((item) => item.startsWith("Create")), false);

    const denied = await startVolcengineAssetUpload(fixture.db, clientFor((action, body) => action === "GetAssetGroup" ? response({ Result: { Id: body.Id, Name: "virtual", GroupType: "AIGC", ProjectName: "default" } }) : response({ Result: { Id: "asset-denied" } })), { projectId, scriptId, targetKind: "asset", targetId: assetId, remoteProjectName: "default", groupId: "group-aigc", groupType: "AIGC", assetType: "Image", mode: "uploadOnly", expectedSourceVersion: 0, expectedSourceFileHash: hash, expectedBindingVersion: null, idempotencyKey: "background-permission-denied" }, "human:9", runtime);
    let deniedRemoteCalls = 0;
    const deniedRunner = createVolcengineTrustedAssetUploadRecovery({ db: fixture.db, client: async () => { deniedRemoteCalls += 1; return recoveryClient; }, runtime: () => runtime, authorize: async () => false });
    await deniedRunner.runOnce();
    assert.equal((await deniedRunner.getState({ kind: "asset", operationId: denied.operationId }))?.stoppedReason, "permission_revoked"); assert.equal(deniedRemoteCalls, 0);

    const retryGroup = await startVolcengineAssetGroupCreation(fixture.db, unknownClient, { projectId, remoteProjectName: "default", name: "待退避虚拟组", groupType: "AIGC", idempotencyKey: "background-backoff-group" }, "human:8");
    const now = Date.now(), failingCalls: string[] = [];
    const failingClient = clientFor((action) => { failingCalls.push(action); throw new Error("temporary upstream error"); });
    const backoffRunner = createVolcengineTrustedAssetUploadRecovery({ db: fixture.db, client: async () => failingClient, runtime: () => runtime, authorize: async () => true, now: () => now });
    await backoffRunner.kick({ kind: "group", operationId: retryGroup.operationId }); const state = await backoffRunner.getState({ kind: "group", operationId: retryGroup.operationId });
    assert.equal(state?.attempts, 1); assert.ok(Number(state?.nextAttemptAt) > now); const attempts = failingCalls.length; await backoffRunner.runOnce(); assert.equal(failingCalls.length, attempts, "backoff must suppress an immediate repeated upstream call");
  } finally { await fixture.destroy(); }
});


test("abandoned pre-submit intents become retryable and a kick cannot steal a live worker lease", options, async () => {
  const fixture = await createPostgresFixture();
  try {
    await migratePostgresFixture(fixture.db); await ensureVolcengineAssetUploadSchema(fixture.db);
    const [projectId] = await insertRowsReturningIds(fixture.db, "o_project", { userId: 1, name: "prepared recovery" });
    const operationId = "6e53b0e8-bf64-4b14-b48c-7fb907a811fa";
    await fixture.db("ext_volcengine_group_creations").insert({ operationId, projectId, actorId: "human:1", idempotencyKey: "prepared-intent-only", requestHash: "a".repeat(64), remoteProjectName: "default", name: "prepared", remoteName: "prepared-trace", description: "", status: "prepared", remoteGroupId: null, error: null, createdAt: 0, updatedAt: 0 });
    let cloudCalls = 0;
    const runner = createVolcengineTrustedAssetUploadRecovery({ db: fixture.db, now: () => 200_000,
      client: async () => { cloudCalls++; throw new Error("cloud must not be called"); }, runtime: () => { throw new Error("runtime must not be called"); }, authorize: async () => true });
    await runner.runOnce();
    const view = await getVolcengineAssetGroupCreation(fixture.db, { projectId, operationId });
    assert.equal(view.status, "rejected"); assert.equal(view.error?.code, "RECOVERY_NOT_SUBMITTED"); assert.equal(cloudCalls, 0);
    await fixture.db("ext_volcengine_group_creations").where({ operationId }).update({ status: "submission_unknown", error: null });
    await fixture.db("ext_volcengine_asset_recovery").insert({ kind: "group", operationId, projectId, actorId: "human:1", attempts: 0, nextAttemptAt: 0, deadlineAt: 900_000, leaseOwner: "another-worker", leaseUntil: 500_000, stoppedReason: null, lastError: null, createdAt: 0, updatedAt: 0 });
    await runner.kick({ kind: "group", operationId });
    assert.equal((await fixture.db("ext_volcengine_asset_recovery").where({ operationId }).first()).leaseOwner, "another-worker");
    assert.equal(cloudCalls, 0);
  } finally { await fixture.destroy(); }
});
