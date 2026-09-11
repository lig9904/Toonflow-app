import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { encodeReviewImage, imageDigest, inlineReferenceHash, localReviewImageReader } from "../src/services/imageReviews/media";
import { reviewVisionCapability } from "../src/services/imageReviews";

test("review encoder reads real pixels, limits dimensions, and preserves image content", async () => {
  const original = await sharp({ create: { width: 2200, height: 1100, channels: 3, background: "red" } }).png().toBuffer();
  const encoded = await encodeReviewImage(original);
  assert.equal(encoded.width, 1536); assert.equal(encoded.height, 768);
  const decoded = await sharp(Buffer.from(encoded.dataUrl.split(",")[1], "base64")).raw().toBuffer();
  assert(decoded[0] > 240 && decoded[1] < 10 && decoded[2] < 10);
  assert.equal(inlineReferenceHash(`data:image/png;base64,${original.toString("base64")}`), imageDigest(original));
  await assert.rejects(encodeReviewImage(Buffer.from("not an image")));
  assert.equal(inlineReferenceHash("data:image/png;base64,broken"), undefined);
});

test("review local media reader rejects URLs, traversal, symlink escape and oversized images", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-review-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "image-review-outside-"));
  try {
    const reader = localReviewImageReader(root);
    await fs.writeFile(path.join(root, "ok.png"), "image bytes");
    assert.equal((await reader("/oss/ok.png")).toString(), "image bytes");
    await fs.writeFile(path.join(outside, "outside.png"), "private");
    await fs.symlink(path.join(outside, "outside.png"), path.join(root, "escape.png"));
    await assert.rejects(reader("https://example.com/ok.png"));
    await assert.rejects(reader("/../outside.png"));
    await assert.rejects(reader("/%2e%2e/outside.png"));
    await assert.rejects(reader("/escape.png"));
    const large = await fs.open(path.join(root, "large.png"), "w");
    await large.truncate(21 * 1024 * 1024); await large.close();
    await assert.rejects(reader("/large.png"), /20MB/);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});

test("only verified official deepseek-flash or an explicit image capability passes", () => {
  const model = { key: "deepseek:deepseek-flash", modelName: "deepseek-flash", enabled: true, type: "text", baseUrl: "https://api.deepseek.com/v1" };
  assert.equal(reviewVisionCapability(model), true);
  assert.equal(reviewVisionCapability({ ...model, baseUrl: "https://api.deepseek.com/" }), true);
  assert.equal(reviewVisionCapability({ ...model, modelName: "deepseek-chat" }), false);
  assert.equal(reviewVisionCapability({ ...model, baseUrl: "https://api.deepseek.com.attacker.invalid" }), false);
  assert.equal(reviewVisionCapability({ ...model, baseUrl: "https://relay.invalid" }), false);
  assert.equal(reviewVisionCapability({ ...model, enabled: false, supportsVision: true }), false);
  assert.equal(reviewVisionCapability({ ...model, modelName: "custom-model", baseUrl: "https://relay.invalid", supportsVision: true }), true);
});
