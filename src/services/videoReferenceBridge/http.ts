import express, { type Request, type Response } from "express";
import fs from "node:fs";
import type { Knex } from "knex";
import {
  cleanupExpiredVideoReferenceLeases,
  renewVideoReferenceLease,
  openStableVideoReferenceFile,
  videoReferenceContentType,
  type VideoReferenceLeaseRow,
  VideoReferenceBridgeError,
} from ".";

export interface VideoReferenceBridgeRouterOptions {
  db: Knex;
  rootDir: string;
  secret: string;
  /** Public HTTPS origin only; this is used when issuing URLs, not trusted from a request. */
  publicOrigin?: string;
  maxBytes?: number;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof VideoReferenceBridgeError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "SIZE_LIMIT" ? 413 : 403;
    res.status(status).send({ code: `MEDIA_BRIDGE_${error.code}`, message: error.message });
    return;
  }
  res.status(404).send({ code: "MEDIA_BRIDGE_NOT_FOUND", message: "媒体桥接资源不可用" });
}

function byteRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return "invalid";
  const suffix = !match[1] ? Number(match[2]) : 0;
  if (!match[1] && (!Number.isSafeInteger(suffix) || suffix <= 0)) return "invalid";
  const start = match[1] ? Number(match[1]) : Math.max(0, size - suffix);
  let end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return "invalid";
  end = Math.min(end, size - 1);
  return { start, end };
}

async function stableStat(lease: VideoReferenceLeaseRow, rootDir: string): Promise<{ handle: any; stat: fs.Stats; absolutePath: string }> {
  const opened = await openStableVideoReferenceFile(rootDir, lease.filePath);
  const { stat } = opened;
  if (stat.size !== lease.sizeBytes || Math.abs(stat.mtimeMs - lease.mtimeMs) > 0.5) { await opened.handle.close(); throw new VideoReferenceBridgeError("FILE_CHANGED", "媒体文件已变更，租约已失效"); }
  return opened;
}

async function serve(req: Request, res: Response, options: VideoReferenceBridgeRouterOptions): Promise<void> {
  try {
    const token = typeof req.params.token === "string" ? req.params.token : "";
    await cleanupExpiredVideoReferenceLeases(options.db);
    const lease = await renewVideoReferenceLease(options.db, token, options.secret);
    const opened = await stableStat(lease, options.rootDir);
    const { handle, stat } = opened;
    const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    if (stat.size > maxBytes) { await handle.close(); throw new VideoReferenceBridgeError("SIZE_LIMIT", "媒体文件超过下载大小限制"); }
    const range = byteRange(typeof req.headers.range === "string" ? req.headers.range : undefined, stat.size);
    if (range === "invalid") {
      await handle.close();
      res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? stat.size - 1;
    let mime: string;
    try { mime = videoReferenceContentType(lease.mediaType, lease.filePath); }
    catch (error) { await handle.close(); throw error; }
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(end - start + 1));
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (range) res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    if (req.method === "HEAD") { await handle.close(); res.end(); return; }
    const stream = handle.createReadStream({ start, end, autoClose: true });
    stream.on("error", () => { if (!res.headersSent) sendError(res, new VideoReferenceBridgeError("NOT_FOUND", "媒体文件不可用")); else res.destroy(); });
    stream.pipe(res);
  } catch (error) {
    sendError(res, error);
  }
}

export function createVideoReferenceBridgeRouter(options: VideoReferenceBridgeRouterOptions): express.Router {
  const router = express.Router();
  router.get("/:token", (req, res) => { void serve(req, res, options); });
  router.head("/:token", (req, res) => { void serve(req, res, options); });
  return router;
}
