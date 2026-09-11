import sharp from "sharp";

export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 50_000_000;

export function isInlineImageData(value: string): boolean {
  return /^data:image\/(?:png|jpeg);base64,/i.test(value);
}

function getInlineImageMime(value: string): "image/png" | "image/jpeg" | undefined {
  const match = /^data:(image\/(?:png|jpeg));base64,/i.exec(value);
  return match?.[1].toLowerCase() as "image/png" | "image/jpeg" | undefined;
}

function decodeInlineImage(value: string): Buffer {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) throw new Error("同步图片 data URI 不合法");
  const base64 = match[2];
  if (base64.length > 56_000_000 || base64.length % 4 !== 0) throw new Error("同步图片 base64 超过 40MB 限制或格式不合法");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== base64) throw new Error("同步图片 base64 解码失败");
  return bytes;
}

export async function decodeAndValidateInlineImage(value: string): Promise<Buffer> {
  const bytes = decodeInlineImage(value);
  const metadata = await validateImageBytes(bytes);
  const mime = getInlineImageMime(value);
  if (!mime || metadata.format !== mime.slice("image/".length)) throw new Error("同步图片 mimeType 与实际文件格式不一致");
  return bytes;
}

/** Metadata alone can accept a truncated container. Force a bounded full decode. */
export async function validateImageBytes(bytes: Buffer): Promise<sharp.Metadata> {
  const options = { limitInputPixels: MAX_IMAGE_PIXELS };
  const metadata = await sharp(bytes, options).metadata();
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error("同步图片不是可解码文件");
  await sharp(bytes, options).ensureAlpha().raw().toBuffer();
  return metadata;
}
