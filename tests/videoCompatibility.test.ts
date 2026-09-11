import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { finalizeAgentsYunVideo, probeVideo } from "../src/services/videoJobs/compatibility";

const exec = promisify(execFile);
const ffmpeg = process.platform === "darwin" ? "/opt/homebrew/bin/ffmpeg" : "/usr/bin/ffmpeg";

async function makeSample(dir: string, name: string, codec: "h264" | "hevc10", options: { pcm?: boolean; hdr?: boolean; rotate?: boolean } = {}): Promise<string> {
  const output = path.join(dir, name);
  const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=${options.rotate ? "48x64" : "64x48"}:rate=2`, ...(options.pcm ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000"] : []), "-t", "1", "-map", "0:v:0", ...(options.pcm ? ["-map", "1:a:0"] : ["-an"]), "-c:v", codec === "h264" ? "libx264" : "libx265", "-pix_fmt", codec === "h264" ? "yuv420p" : "yuv420p10le", ...(options.pcm ? ["-c:a", "pcm_s16le", "-f", "matroska"] : []), ...(options.pcm ? [] : ["-c:a", "aac"]), ...(options.hdr ? ["-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc"] : []), ...(options.rotate ? ["-metadata:s:v:0", "rotate=90"] : []), ...(codec === "hevc10" ? ["-x265-params", "log-level=error"] : []), output];
  await exec(ffmpeg, args, { timeout: 30_000 });
  return output;
}

test("H264 yuv420p files are published byte-for-byte without conversion", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".video-compat-test-"));
  try {
    const original = await makeSample(dir, "h264.source.mp4", "h264");
    const expected = await readFile(original);
    const output = path.join(dir, "h264.mp4");
    const result = await finalizeAgentsYunVideo(original, output);
    assert.equal(result.converted, false);
    assert.deepEqual(await readFile(output), expected);
    await assert.rejects(stat(original));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("HEVC 10-bit files retain the source and publish an H264 yuv420p companion", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".video-compat-test-"));
  try {
    const original = await makeSample(dir, "hevc.source.mp4", "hevc10");
    const output = path.join(dir, "hevc.mp4");
    const result = await finalizeAgentsYunVideo(original, output);
    assert.equal(result.converted, true);
    assert.equal((await probeVideo(original)).codec, "hevc");
    const converted = await probeVideo(output);
    assert.equal(converted.codec, "h264");
    assert.equal(converted.pixelFormat, "yuv420p");
    assert.equal(converted.width, result.probe.width);
    assert.equal(converted.height, result.probe.height);
    assert.ok(await stat(original));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("H264 with PCM audio is converted to playable AAC while preserving portrait display dimensions", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".video-compat-test-"));
  try {
    const original = await makeSample(dir, "pcm.source.mp4", "h264", { pcm: true, rotate: true });
    const sourceProbe = await probeVideo(original);
    assert.equal(sourceProbe.audioCodec, "pcm_s16le");
    const output = path.join(dir, "pcm.mp4");
    const result = await finalizeAgentsYunVideo(original, output);
    const converted = await probeVideo(output);
    assert.equal(result.converted, true);
    assert.equal(converted.codec, "h264");
    assert.equal(converted.pixelFormat, "yuv420p");
    assert.equal(converted.audioCodec, "aac");
    assert.equal(converted.displayWidth, sourceProbe.displayWidth);
    assert.equal(converted.displayHeight, sourceProbe.displayHeight);
    assert.ok(await stat(original));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("HDR input is explicitly rejected and source is retained without publishing output", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".video-compat-test-"));
  try {
    const source = await makeSample(dir, "hdr.source.mp4", "hevc10", { hdr: true });
    const output = path.join(dir, "hdr.mp4");
    await assert.rejects(finalizeAgentsYunVideo(source, output), /HDR|10-bit/);
    assert.ok(await stat(source));
    await assert.rejects(stat(output));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid Agent cloud media never publishes a main output", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".video-compat-test-"));
  try {
    const source = path.join(dir, "invalid.source.mp4");
    const output = path.join(dir, "invalid.mp4");
    await writeFile(source, Buffer.from("invalid"));
    await assert.rejects(finalizeAgentsYunVideo(source, output), /探测失败|探测结果/);
    await assert.rejects(stat(output));
    assert.ok(await stat(source));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
