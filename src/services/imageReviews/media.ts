import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { canonicalMediaPath } from "../../lib/mediaOwnership";

export const MAX_REVIEW_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REVIEW_REFERENCES = 8;
export const MAX_REVIEW_TOTAL_BYTES = 80 * 1024 * 1024;
export const imageDigest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** Only local/NAS media below the configured media root. No URL fetch or symlink escape. */
export function localReviewImageReader(rootDirectory: string): (filePath: string) => Promise<Buffer> {
  return async (value) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error("核验仅支持已登记的本地媒体路径");
    const canonical = canonicalMediaPath(value);
    if (/%(?:2e|2f|5c|00)/i.test(canonical)) throw new Error("核验图片路径无效");
    const root = await fs.realpath(rootDirectory);
    const resolved = await fs.realpath(path.join(root, canonical.slice(1)));
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("核验图片越过媒体目录");
    const handle = await fs.open(resolved, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_REVIEW_IMAGE_BYTES) throw new Error("核验图片必须是 20MB 以内的文件");
      // Bounded read also protects against a file growing between stat and read.
      const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_REVIEW_IMAGE_BYTES + 1));
      let count = 0;
      while (count < bytes.length) {
        const next = await handle.read(bytes, count, bytes.length - count, count);
        if (!next.bytesRead) break;
        count += next.bytesRead;
      }
      if (count !== stat.size) throw new Error("核验图片在读取期间发生变化");
      return bytes.subarray(0, count);
    } finally { await handle.close(); }
  };
}

export function inlineReferenceHash(value: string): string | undefined {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match || match[1].length > Math.ceil(MAX_REVIEW_IMAGE_BYTES / 3) * 4) return undefined;
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length || bytes.toString("base64") !== match[1]) return undefined;
  return imageDigest(bytes);
}

/** Decode real pixels and emit bounded JPEG bytes, preserving ordering via adjacent labels. */
export async function encodeReviewImage(bytes: Buffer): Promise<{ dataUrl: string; width: number; height: number }> {
  if (!bytes.length || bytes.length > MAX_REVIEW_IMAGE_BYTES) throw new Error("核验图片超过 20MB 限制");
  const options = { limitInputPixels: 40_000_000, failOn: "error" as const };
  const metadata = await sharp(bytes, options).metadata();
  if (!metadata.width || !metadata.height || !["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1) throw new Error("核验仅支持单帧 PNG、JPEG、WebP 图片");
  const result = await sharp(bytes, options).rotate().resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).flatten({ background: "white" }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
  return { dataUrl: `data:image/jpeg;base64,${result.data.toString("base64")}`, width: result.info.width, height: result.info.height };
}
