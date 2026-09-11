import test from "node:test";
import assert from "node:assert/strict";
import { imageOutputSizes, validateImageOutputSize } from "../src/lib/imageRequestCapabilities";
import { projectConfigurationIssue } from "../src/services/projectContent/configuration";

test("registered relay image capabilities remove 4K and reject it in project configuration", () => {
  const key = "zhenzhenRelay:seedream-v5-pro-i2i";
  const resolutions = imageOutputSizes(key, { resolutions: ["1K", "2K", "4K"] });
  assert.deepEqual(resolutions, ["1K", "2K"]);
  assert.throws(() => validateImageOutputSize(key, "4K"), /1K\/2K/);
  const metadata = { models: [{ key, type: "image" as const, modes: ["singleImage"], resolutions }, { key: "video", type: "video" as const, modes: ["text"] }], artStyles: ["ink"], directorManuals: ["basic"] };
  const values = { imageModel: key, videoModel: "video", imageQuality: "4K", videoRatio: "9:16", mode: "text", artStyle: "ink", directorManual: "basic" };
  assert.match(projectConfigurationIssue(values, metadata)!, /图片质量/);
  assert.equal(projectConfigurationIssue({ ...values, imageQuality: "2K" }, metadata), null);
});

test("other providers can declare a restricted or differently named image quality set", () => {
  assert.deepEqual(imageOutputSizes("other:custom", { resolutions: ["medium", "high", "high", null] }), ["medium", "high"]);
});

test("Agent cloud image metadata exposes 3K only for the Lite model", () => {
  assert.deepEqual(imageOutputSizes("agentsYun:Doubao-Seedream-4.5", { sizes: ["2K", "4K"] }), ["2K", "4K"]);
  assert.deepEqual(imageOutputSizes("agentsYun:Doubao-Seedream-5.0-Lite", { sizes: ["2K", "3K", "4K"] }), ["2K", "3K", "4K"]);
  assert.throws(() => validateImageOutputSize("agentsYun:Doubao-Seedream-4.5", "3K", { sizes: ["2K", "4K"] }), /不支持 3K/);
  assert.doesNotThrow(() => validateImageOutputSize("agentsYun:Doubao-Seedream-5.0-Lite", "3K", { sizes: ["2K", "3K", "4K"] }));
  assert.deepEqual(imageOutputSizes("legacy:unknown", {}), ["1K", "2K", "4K"]);
  assert.throws(() => validateImageOutputSize("legacy:unknown", "3K"), /不支持 3K/);
});
