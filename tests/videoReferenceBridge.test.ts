import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";
import express from "express";
import knex, { type Knex } from "knex";
import {
  cleanupExpiredVideoReferenceLeases,
  ensureVideoReferenceBridgeSchema,
  issueVideoReferenceLease,
  issueProjectAssetReferenceLease,
  lookupVideoReferenceLease,
  renewVideoReferenceConfigLeases,
  VideoReferenceBridgeError,
} from "../src/services/videoReferenceBridge";
import { createVideoReferenceBridgeRouter } from "../src/services/videoReferenceBridge/http";
import { hashVideoJobRequest } from "../src/services/videoJobs";

const secret = "bridge-test-secret-012345678901234567890";
const openFile = async (root: string, file = "100/assets/ref.mp4") => {
  const full = path.join(root, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, Buffer.from("0123456789abcdef"));
  return `/${file}`;
};

async function fixture(): Promise<{ db: Knex; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "toonflow-reference-bridge-"));
  const db = knex({ client: "better-sqlite3", connection: { filename: path.join(root, "bridge.sqlite") }, useNullAsDefault: true });
  await db.schema.createTable("o_project", (t) => { t.integer("id").primary(); });
  await db.schema.createTable("o_script", (t) => { t.integer("id").primary(); t.integer("projectId"); });
  await db.schema.createTable("o_assets", (t) => { t.integer("id").primary(); t.integer("projectId"); t.integer("imageId"); });
  await db.schema.createTable("o_scriptAssets", (t) => { t.integer("scriptId"); t.integer("assetId"); });
  await db.schema.createTable("o_image", (t) => { t.integer("id").primary(); t.integer("assetsId"); t.text("filePath"); t.text("type"); });
  await db.schema.createTable("o_storyboard", (t) => { t.integer("id").primary(); t.integer("projectId"); t.integer("scriptId"); t.text("filePath"); });
  await db.schema.createTable("o_video", (t) => { t.integer("id").primary(); t.integer("projectId"); t.text("filePath"); });
  const filePath = await openFile(root);
  const audioPath = await openFile(root, "100/assets/ref.wav");
  const unknownPath = await openFile(root, "100/assets/ref.bin");
  await db("o_project").insert({ id: 100 });
  await db("o_script").insert({ id: 10, projectId: 100 });
  await db("o_assets").insert({ id: 20, projectId: 100, imageId: 30 });
  await db("o_scriptAssets").insert({ scriptId: 10, assetId: 20 });
  await db("o_image").insert({ id: 30, assetsId: 20, filePath: filePath, type: "video" });
  await db("o_assets").insert([{ id: 21, projectId: 100, imageId: 31 }, { id: 22, projectId: 100, imageId: 32 }]);
  await db("o_scriptAssets").insert([{ scriptId: 10, assetId: 21 }, { scriptId: 10, assetId: 22 }]);
  await db("o_image").insert([{ id: 31, assetsId: 21, filePath: audioPath, type: "audio" }, { id: 32, assetsId: 22, filePath: unknownPath, type: "audio" }]);
  await db("o_storyboard").insert({ id: 40, projectId: 100, scriptId: 10, filePath: "/100/assets/ref.mp4" });
  await ensureVideoReferenceBridgeSchema(db);
  return { db, root };
}

async function close(f: { db: Knex; root: string }): Promise<void> {
  await f.db.destroy();
  await rm(f.root, { recursive: true, force: true });
}

describe("video reference bridge", () => {
  let current: { db: Knex; root: string } | undefined;
  afterEach(async () => { if (current) await close(current); current = undefined; });

  it("uploads a project-owned asset without inventing an episode or weakening video ownership", async () => {
    current = await fixture();
    await current.db("o_scriptAssets").where({ assetId: 20 }).delete();
    const options = { rootDir: current.root, publicOrigin: "https://media.example.test", secret };
    const lease = await issueProjectAssetReferenceLease(current.db, { projectId: 100, id: 20 }, options);
    const token = lease.url.split("/").pop()!;
    const row = await lookupVideoReferenceLease(current.db, token, secret);
    assert.equal(row.sourceKind, "projectAssets"); assert.equal(row.scriptId, 0);
    assert.equal((await current.db("o_script").select()).length, 1);
    assert.equal((await current.db("o_scriptAssets").where({ assetId: 20 }).select()).length, 0);
    await assert.rejects(issueProjectAssetReferenceLease(current.db, { projectId: 999, id: 20 }, options), /不属于/);
    await assert.rejects(issueVideoReferenceLease(current.db, { projectId: 100, scriptId: 10, id: 20, sources: "assets" }, options), /不属于/);
    await assert.rejects(issueVideoReferenceLease(current.db, { projectId: 100, scriptId: 0, id: 20, sources: "projectAssets" } as any, options), /来源不合法/);
    await current.db("o_assets").where({ id: 20 }).update({ imageId: 31 });
    await assert.rejects(lookupVideoReferenceLease(current.db, token, secret), /已更换/);
  });

  it("issues a stable project-scoped lease and renews it without changing token", async () => {
    current = await fixture();
    const source = { projectId: 100, scriptId: 10, id: 20, sources: "assets" as const, fileType: "video" as const };
    const first = await issueVideoReferenceLease(current.db, source, { rootDir: current.root, publicOrigin: "https://media.example.test", secret, now: 1_000 });
    const second = await issueVideoReferenceLease(current.db, source, { rootDir: current.root, publicOrigin: "https://media.example.test", secret, now: 1_000 });
    assert.equal(first.url, second.url);
    assert.equal(first.leaseId, second.leaseId);
    assert.equal(second.expiresAt >= first.expiresAt, true);
    const slightlyLater = await issueVideoReferenceLease(current.db, source, { rootDir: current.root, publicOrigin: "https://media.example.test", secret, now: 1_010 });
    assert.equal(slightlyLater.leaseId, first.leaseId, "normal sequential calls should renew the same lease within its hard lifetime");
    const concurrent = await Promise.all([
      issueVideoReferenceLease(current.db, source, { rootDir: current.root, publicOrigin: "https://media.example.test", secret, now: 1_000 }),
      issueVideoReferenceLease(current.db, source, { rootDir: current.root, publicOrigin: "https://media.example.test", secret, now: 1_000 }),
    ]);
    assert.equal(concurrent[0].leaseId, concurrent[1].leaseId);
    await assert.rejects(issueVideoReferenceLease(current.db, { ...source, scriptId: 999 }, { rootDir: current.root, publicOrigin: "https://media.example.test", secret }), (error: any) => error instanceof VideoReferenceBridgeError && error.code === "PROJECT_MISMATCH");
  });

  it("keeps bridge credentials out of the business hash and preserves legacy base64 identity", () => {
    const base = { modelKey: "kzOpenApi:doubao-seedance-2-5-260628", providerFingerprint: "provider", projectId: 100, scriptId: 10, trackId: 1 };
    const first = hashVideoJobRequest({ ...base, config: { referenceList: [{ type: "video", source: { projectId: 100, scriptId: 10, id: 20, sources: "assets" }, contentHash: "abc", sizeBytes: 16, mtimeMs: 1, url: "https://media.example.test/media-bridge/a", expiresAt: 100 }] } });
    const renewed = hashVideoJobRequest({ ...base, config: { referenceList: [{ type: "video", source: { projectId: 100, scriptId: 10, id: 20, sources: "assets" }, contentHash: "abc", sizeBytes: 16, mtimeMs: 1, url: "https://media.example.test/media-bridge/b", expiresAt: 200 }] } });
    assert.equal(first, renewed);
    assert.notEqual(first, hashVideoJobRequest({ ...base, config: { referenceList: [{ type: "video", source: { projectId: 100, scriptId: 10, id: 20, sources: "assets" }, contentHash: "changed", sizeBytes: 16, mtimeMs: 1, url: "https://media.example.test/media-bridge/a" }] } }));
    assert.notEqual(first, hashVideoJobRequest({ ...base, config: { referenceList: [{ type: "video", base64: "data:video/mp4;base64,AAAA" }] } }));
  });

  it("creates a new lease generation when the old token cannot cover the full TTL", async () => {
    current = await fixture();
    const source = { projectId: 100, scriptId: 10, id: 20, sources: "assets" as const, fileType: "video" as const };
    const ttl = 72 * 60 * 60 * 1000;
    const hard = 73 * 60 * 60 * 1000;
    const first = await issueVideoReferenceLease(current.db, source, { rootDir: current.root, publicOrigin: "https://media.example.test", secret, now: 0, ttlMs: ttl, hardTtlMs: hard });
    const second = await issueVideoReferenceLease(current.db, source, { rootDir: current.root, publicOrigin: "https://media.example.test", secret, now: 2 * 60 * 60 * 1000, ttlMs: ttl, hardTtlMs: hard });
    assert.notEqual(first.leaseId, second.leaseId);
    assert.equal(await current.db("ext_video_reference_leases").count("leaseId as count").first().then((row) => Number(row?.count)), 2);
    assert.equal((await lookupVideoReferenceLease(current.db, new URL(first.url).pathname.split("/").pop()!, secret, 2 * 60 * 60 * 1000)).leaseId, first.leaseId);
    assert.equal((await lookupVideoReferenceLease(current.db, new URL(second.url).pathname.split("/").pop()!, secret, 2 * 60 * 60 * 1000)).leaseId, second.leaseId);
  });

  it("serves only the leased file with HEAD, byte ranges, and no team cookie", async () => {
    current = await fixture();
    const lease = await issueVideoReferenceLease(current.db, { projectId: 100, scriptId: 10, id: 20, sources: "assets", fileType: "video" }, { rootDir: current.root, publicOrigin: "https://media.example.test", secret });
    const token = new URL(lease.url).pathname.split("/").pop()!;
    const app = express();
    app.use("/media-bridge", createVideoReferenceBridgeRouter({ db: current.db, rootDir: current.root, secret }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = server.address() as { port: number };
      const base = `http://127.0.0.1:${address.port}/media-bridge/${token}`;
      const head = await fetch(base, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("content-length"), "16");
      assert.equal(head.headers.get("cache-control"), "private, no-store");
      const range = await fetch(base, { headers: { Range: "bytes=2-5" } });
      assert.equal(range.status, 206);
      assert.equal(await range.text(), "2345");
      const suffix = await fetch(base, { headers: { Range: "bytes=-4" } });
      assert.equal(suffix.status, 206);
      assert.equal(await suffix.text(), "cdef");
      const openEnded = await fetch(base, { headers: { Range: "bytes=4-" } });
      assert.equal(openEnded.status, 206);
      assert.equal(await openEnded.text(), "456789abcdef");
      assert.equal((await fetch(base, { headers: { Range: "bytes=-0" } })).status, 416);
      assert.equal((await fetch(base, { headers: { Range: "bytes=0-1,2-3" } })).status, 416);
      assert.equal((await fetch(base, { headers: { Range: "bytes=999-" } })).status, 416);
      const wrong = await fetch(`${base}x`);
      assert.equal(wrong.status, 404);
      await writeFile(path.join(current.root, "100/assets/ref.mp4"), Buffer.from("changed-size"));
      const changed = await fetch(base);
      assert.equal(changed.status, 403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects external symlinks, permits a symlinked root, and emits real audio MIME", async () => {
    current = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "toonflow-reference-outside-"));
    try {
      await writeFile(path.join(outside, "secret.mp4"), Buffer.from("outside"));
      await symlink(path.join(outside, "secret.mp4"), path.join(current.root, "100/assets/escape.mp4"));
      await current.db("o_assets").insert({ id: 23, projectId: 100, imageId: 33 });
      await current.db("o_scriptAssets").insert({ scriptId: 10, assetId: 23 });
      await current.db("o_image").insert({ id: 33, assetsId: 23, filePath: "/100/assets/escape.mp4", type: "video" });
      await assert.rejects(issueVideoReferenceLease(current.db, { projectId: 100, scriptId: 10, id: 23, sources: "assets", fileType: "video" }, { rootDir: current.root, publicOrigin: "https://media.example.test", secret }), /媒体文件超出|媒体文件不可用|不存在/);
      const linkedRoot = `${current.root}-link`;
      await symlink(current.root, linkedRoot, "dir");
      const audio = await issueVideoReferenceLease(current.db, { projectId: 100, scriptId: 10, id: 21, sources: "assets", fileType: "audio" }, { rootDir: linkedRoot, publicOrigin: "https://media.example.test", secret });
      const token = new URL(audio.url).pathname.split("/").pop()!;
      const app = express();
      app.use("/media-bridge", createVideoReferenceBridgeRouter({ db: current.db, rootDir: linkedRoot, secret }));
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      try {
        const address = server.address() as { port: number };
        const response = await fetch(`http://127.0.0.1:${address.port}/media-bridge/${token}`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "audio/wav");
      } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("rejects an image pointer into another project and shared paths with ambiguous ownership", async () => {
    current = await fixture();
    await current.db("o_project").insert({ id: 200 });
    await current.db("o_assets").insert([{ id: 24, projectId: 100, imageId: 34 }, { id: 25, projectId: 200, imageId: 35 }]);
    await current.db("o_scriptAssets").insert([{ scriptId: 10, assetId: 24 }]);
    // Asset 24 (project 100) points at an image row owned by asset 25
    // (project 200), modelling the dirty imageId cross-reference.
    await current.db("o_image").insert([{ id: 34, assetsId: 25, filePath: "/200/assets/foreign.mp4", type: "video" }, { id: 35, assetsId: 25, filePath: "/100/assets/ref.mp4", type: "video" }]);
    await mkdir(path.join(current.root, "200/assets"), { recursive: true });
    await writeFile(path.join(current.root, "200/assets/foreign.mp4"), Buffer.from("foreign"));
    await assert.rejects(issueVideoReferenceLease(current.db, { projectId: 100, scriptId: 10, id: 24, sources: "assets", fileType: "video" }, { rootDir: current.root, publicOrigin: "https://media.example.test", secret }), /没有当前项目的唯一归属|不属于当前项目/);
    await assert.rejects(issueVideoReferenceLease(current.db, { projectId: 100, scriptId: 10, id: 20, sources: "assets", fileType: "video" }, { rootDir: current.root, publicOrigin: "https://media.example.test", secret }), /没有当前项目的唯一归属/);
  });

  it("keeps an old snapshot usable after the selected image pointer changes, but rejects deleted projects", async () => {
    current = await fixture();
    const source = { projectId: 100, scriptId: 10, id: 20, sources: "assets" as const, fileType: "video" as const };
    const lease = await issueVideoReferenceLease(current.db, source, { rootDir: current.root, publicOrigin: "https://media.example.test", secret });
    await current.db("o_image").insert({ id: 36, assetsId: 20, filePath: "/100/assets/other.mp4", type: "video" });
    await writeFile(path.join(current.root, "100/assets/other.mp4"), Buffer.from("other"));
    await current.db("o_assets").where({ id: 20 }).update({ imageId: 36 });
    const token = new URL(lease.url).pathname.split("/").pop()!;
    assert.equal((await lookupVideoReferenceLease(current.db, token, secret)).leaseId, lease.leaseId);
    await current.db("o_project").where({ id: 100 }).delete();
    await assert.rejects(lookupVideoReferenceLease(current.db, token, secret), /项目已不存在/);
  });

  it("rejects unknown media extensions instead of pretending they are audio", async () => {
    current = await fixture();
    await assert.rejects(issueVideoReferenceLease(current.db, { projectId: 100, scriptId: 10, id: 22, sources: "assets", fileType: "audio" }, { rootDir: current.root, publicOrigin: "https://media.example.test", secret }), /不支持的audio/);
  });

  it("does not re-sign a durable task after the source file changes", async () => {
    current = await fixture();
    const source = { projectId: 100, scriptId: 10, id: 20, sources: "assets" as const, fileType: "video" as const };
    const lease = await issueVideoReferenceLease(current.db, source, { rootDir: current.root, publicOrigin: "https://media.example.test", secret });
    await writeFile(path.join(current.root, "100/assets/ref.mp4"), Buffer.from("changed-size"));
    await assert.rejects(renewVideoReferenceConfigLeases(current.db, { referenceList: [{ type: "video", url: lease.url, source, contentHash: lease.contentHash, sizeBytes: lease.sizeBytes, mtimeMs: lease.mtimeMs }] }, { rootDir: current.root, publicOrigin: "https://media.example.test", secret }), /已变更|不能重签/);
  });

  it("cleans expired leases without touching media files", async () => {
    current = await fixture();
    const lease = await issueVideoReferenceLease(current.db, { projectId: 100, scriptId: 10, id: 20, sources: "assets", fileType: "video" }, { rootDir: current.root, publicOrigin: "https://media.example.test", secret, now: 1_000, ttlMs: 2_000, hardTtlMs: 3_000 });
    assert.equal(await cleanupExpiredVideoReferenceLeases(current.db, lease.expiresAt + 1), 1);
    assert.equal((await readFile(path.join(current.root, "100/assets/ref.mp4"))).length, 16);
  });
});
