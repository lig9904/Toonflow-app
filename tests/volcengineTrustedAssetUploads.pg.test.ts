import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createPostgresFixture, migratePostgresFixture } from "../src/lib/postgresTest";
import { insertRowsReturningIds } from "../src/lib/insertRows";
import { ensureCreativeWorkspaceSchema } from "../src/services/creativeWorkspace";
import { ensureProductionStateSchema } from "../src/services/productionState";
import { readVolcengineReferenceBindings, VolcengineTrustedAssetClient } from "../src/services/volcengineTrustedAssets";
import {
  getVolcengineAssetUpload,
  createVolcengineAssetUploadRuntime,
  listVolcengineAssetGroupCreations,
  listVolcengineAssetUploads,
  startVolcengineAssetGroupCreation,
  startVolcengineAssetUpload,
  syncVolcengineAssetGroupCreation,
  syncVolcengineAssetUpload,
  type VolcengineAssetUploadRuntime,
} from "../src/services/volcengineTrustedAssetUploads";

const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function remote(state: { calls: string[]; unknownGroups: boolean; unknownAssets: boolean }) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const action = new URL(String(input)).searchParams.get("Action") ?? "", body = JSON.parse(String(init?.body ?? "{}")); state.calls.push(action);
    if (action === "CreateAssetGroup") { if (state.unknownGroups) throw new Error("timeout"); return response({ Result: { Id: "group-created" } }); }
    if (action === "ListAssetGroups") return response({ Result: { Items: [{ Id: "group-recovered", Name: body.Filter.Name, GroupType: "AIGC", ProjectName: body.ProjectName }] } });
    if (action === "GetAssetGroup") return response({ Result: { Id: body.Id, Name: "virtual", GroupType: "AIGC", ProjectName: body.ProjectName } });
    if (action === "CreateAsset") { if (state.unknownAssets) throw new Error("timeout"); return response({ Result: { Id: "asset-created" } }); }
    if (action === "ListAssets") return response({ Result: { Items: [{ Id: "asset-recovered", GroupId: "group-aigc", Name: body.Filter.Name, AssetType: "Image", Status: "Active", ProjectName: body.ProjectName }] } });
    if (action === "GetAsset") return response({ Result: { Id: body.Id, GroupId: "group-aigc", Name: "virtual image", AssetType: "Image", Status: "Active", ProjectName: body.ProjectName } });
    return response({ ResponseMetadata: { Error: { Code: "UnknownAction", Message: "unsupported" } } }, 400);
  };
}

test("AIGC group creation records unknown outcomes and only uses list recovery", options, async () => {
  const fixture = await createPostgresFixture();
  try {
    await migratePostgresFixture(fixture.db);
    const [projectId] = await insertRowsReturningIds(fixture.db, "o_project", { userId: 1, name: "upload groups" });
    const state = { calls: [] as string[], unknownGroups: true, unknownAssets: false };
    const client = new VolcengineTrustedAssetClient({ credentials: { accessKeyId: "AKTESTONLY123", secretAccessKey: "SKTESTONLY456" }, fetch: remote(state) });
    const input = { projectId, remoteProjectName: "default", name: "虚拟角色", description: "Toonflow AIGC", groupType: "AIGC" as const, idempotencyKey: "group-create-unknown" };
    const first = await startVolcengineAssetGroupCreation(fixture.db, client, input, "human:1");
    assert.equal(first.status, "submission_unknown"); assert.equal(state.calls.filter((item) => item === "CreateAssetGroup").length, 1);
    const replay = await startVolcengineAssetGroupCreation(fixture.db, client, input, "human:1");
    assert.equal(replay.operationId, first.operationId); assert.equal(state.calls.filter((item) => item === "CreateAssetGroup").length, 1, "unknown receipt must never repeat CreateAssetGroup");
    const recovered = await syncVolcengineAssetGroupCreation(fixture.db, client, { projectId, operationId: first.operationId });
    assert.equal(recovered.status, "created"); assert.equal(recovered.remoteGroupId, "group-recovered");
    assert.equal((await listVolcengineAssetGroupCreations(fixture.db, { projectId })).items.length, 1);
    const [otherProjectId] = await insertRowsReturningIds(fixture.db, "o_project", { userId: 1, name: "other upload groups" });
    const other = await startVolcengineAssetGroupCreation(fixture.db, client, { ...input, projectId: otherProjectId }, "human:1");
    assert.notEqual(other.remoteName, first.remoteName, "same visible name and idempotency key in another local project must have a different recovery trace");
    await assert.rejects(startVolcengineAssetGroupCreation(fixture.db, client, { ...input, groupType: "LivenessFace" }, "human:1"), /AIGC/);
  } finally { await fixture.destroy(); }
});

test("AIGC upload persists source snapshot, binds only after Active, and never repeats an unknown CreateAsset", options, async () => {
  const fixture = await createPostgresFixture();
  try {
    await migratePostgresFixture(fixture.db); await ensureCreativeWorkspaceSchema(fixture.db); await ensureProductionStateSchema(fixture.db);
    const [projectId] = await insertRowsReturningIds(fixture.db, "o_project", { userId: 1, name: "asset uploads" });
    const [scriptId] = await insertRowsReturningIds(fixture.db, "o_script", { projectId, name: "episode", content: "scene" });
    const [imageId] = await insertRowsReturningIds(fixture.db, "o_image", { filePath: "/upload/virtual.png", type: "role", state: "已完成" });
    const [assetId] = await insertRowsReturningIds(fixture.db, "o_assets", { projectId, name: "virtual", type: "role", imageId });
    await fixture.db("o_image").where({ id: imageId }).update({ assetsId: assetId });
    await fixture.db("o_scriptAssets").insert({ scriptId, assetId });
    const sourceFileHash = "a".repeat(64);
    const runtime: VolcengineAssetUploadRuntime = {
      hashSource: async () => sourceFileHash,
      prepareSource: async () => ({ sourceVersion: 0, sourceFilePath: "/upload/virtual.png", sourceFileHash, mediaType: "Image", leaseUrl: "https://media.example.test/media-bridge/token", leaseId: "lease-test", contentHash: "b".repeat(64), sizeBytes: 500_000, mtimeMs: 1, expiresAt: Date.now() + 60_000 }),
    };
    const state = { calls: [] as string[], unknownGroups: false, unknownAssets: false };
    const client = new VolcengineTrustedAssetClient({ credentials: { accessKeyId: "AKTESTONLY123", secretAccessKey: "SKTESTONLY456" }, fetch: remote(state) });
    const input = { projectId, scriptId, targetKind: "asset" as const, targetId: assetId, remoteProjectName: "default", groupId: "group-aigc", groupType: "AIGC" as const, name: "虚拟角色正面", assetType: "Image" as const, mode: "uploadAndBind" as const, expectedSourceVersion: 0, expectedSourceFileHash: sourceFileHash, expectedBindingVersion: 0, idempotencyKey: "asset-upload-bind" };
    const started = await startVolcengineAssetUpload(fixture.db, client, input, "human:1", runtime);
    assert.equal(started.status, "processing"); assert.equal(started.bindStatus, "pending"); assert.equal(started.remoteAssetId, "asset-created");
    const active = await syncVolcengineAssetUpload(fixture.db, client, { projectId, operationId: started.operationId }, runtime);
    assert.equal(active.status, "active"); assert.equal(active.bindStatus, "bound");
    const binding = await readVolcengineReferenceBindings(fixture.db, { projectId, scriptId, targetKind: "asset", targetId: assetId });
    assert.equal(binding.items[0].assetId, "asset-created"); assert.equal(binding.items[0].groupType, "AIGC");

    const conflictStarted = await startVolcengineAssetUpload(fixture.db, client, { ...input, idempotencyKey: "asset-upload-bind-conflict" }, "human:1", runtime);
    const conflict = await syncVolcengineAssetUpload(fixture.db, client, { projectId, operationId: conflictStarted.operationId }, runtime);
    assert.equal(conflict.status, "active"); assert.equal(conflict.bindStatus, "conflict", "a stale binding CAS must preserve the Active remote upload for manual binding");

    state.unknownAssets = true;
    const unknownInput = { ...input, mode: "uploadOnly" as const, expectedBindingVersion: null, idempotencyKey: "asset-upload-unknown" };
    const unknown = await startVolcengineAssetUpload(fixture.db, client, unknownInput, "human:1", runtime);
    assert.equal(unknown.status, "submission_unknown"); const createCalls = state.calls.filter((item) => item === "CreateAsset").length;
    const replay = await startVolcengineAssetUpload(fixture.db, client, unknownInput, "human:1", runtime);
    assert.equal(replay.operationId, unknown.operationId); assert.equal(state.calls.filter((item) => item === "CreateAsset").length, createCalls);
    const recovered = await syncVolcengineAssetUpload(fixture.db, client, { projectId, idempotencyKey: "asset-upload-unknown" }, runtime);
    assert.equal(recovered.status, "active"); assert.equal(recovered.remoteAssetId, "asset-recovered"); assert.equal(recovered.bindStatus, "not_requested");
    assert.equal((await getVolcengineAssetUpload(fixture.db, { projectId, operationId: unknown.operationId })).status, "active");
    assert.equal((await listVolcengineAssetUploads(fixture.db, { projectId, scriptId, targetKind: "asset", targetId: assetId })).items.length, 3);
    await assert.rejects(startVolcengineAssetUpload(fixture.db, client, { ...input, groupType: "LivenessFace", idempotencyKey: "no-real-person" }, "human:1", runtime), /AIGC/);
  } finally { await fixture.destroy(); }
});

test("upload runtime uses the controlled media bridge for a project-level Toonflow image", options, async () => {
  const fixture = await createPostgresFixture(), root = await mkdtemp(path.join(os.tmpdir(), "toonflow-aigc-upload-"));
  try {
    await migratePostgresFixture(fixture.db); await ensureCreativeWorkspaceSchema(fixture.db); await ensureProductionStateSchema(fixture.db);
    const [projectId] = await insertRowsReturningIds(fixture.db, "o_project", { userId: 1, name: "runtime upload" });
    await mkdir(path.join(root, "upload"), { recursive: true });
    const absolute = path.join(root, "upload", "virtual.png");
    await sharp({ create: { width: 640, height: 640, channels: 4, background: "#f4f1e8" } }).png().toFile(absolute);
    const [imageId] = await insertRowsReturningIds(fixture.db, "o_image", { filePath: "/upload/virtual.png", type: "role", state: "已完成" });
    const [assetId] = await insertRowsReturningIds(fixture.db, "o_assets", { projectId, name: "virtual", type: "role", imageId });
    await fixture.db("o_image").where({ id: imageId }).update({ assetsId: assetId });
    const hashSource = async (filePath: string) => createHash("sha256").update(await readFile(path.join(root, filePath.replace(/^\/+/, "")))).digest("hex");
    const expectedSourceFileHash = await hashSource("/upload/virtual.png");
    const runtime = createVolcengineAssetUploadRuntime(fixture.db, { rootDir: root, publicOrigin: "https://media.example.test", secret: "test-secret-that-is-at-least-32-bytes-long" }, hashSource);
    const prepared = await runtime.prepareSource({ projectId, targetKind: "asset", targetId: assetId, remoteProjectName: "default", groupId: "group-aigc", groupType: "AIGC", assetType: "Image", mode: "uploadOnly", expectedSourceVersion: 0, expectedSourceFileHash, expectedBindingVersion: null, idempotencyKey: "runtime-project-image" });
    assert.equal(prepared.mediaType, "Image"); assert.equal(prepared.sourceFileHash, expectedSourceFileHash); assert.match(prepared.leaseUrl, /^https:\/\/media\.example\.test\/media-bridge\//);
    const lease = await fixture.db("ext_video_reference_leases").where({ leaseId: prepared.leaseId }).first();
    assert.equal(lease.projectId, projectId); assert.equal(lease.scriptId, 0); assert.equal(lease.sourceKind, "projectAssets"); assert.equal((await fixture.db("o_script").select()).length, 0); assert.equal(Object.hasOwn(lease, "url"), false);
  } finally { await fixture.destroy(); await rm(root, { recursive: true, force: true }); }
});
