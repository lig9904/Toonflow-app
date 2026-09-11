import test from "node:test";
import assert from "node:assert/strict";
import { resolveVideoMode, VideoModeResolutionError, type VideoModeReference } from "../src/services/videoModeResolution";

const multi = ["imageReference:4", "videoReference:2", "audioReference:2"];
const capabilities = { mode: ["text", "singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", multi] };
const ref = (id: number, fileType: VideoModeReference["fileType"], purpose: VideoModeReference["purpose"]): VideoModeReference => ({ id, sources: fileType === "image" && id < 10 ? "storyboard" : "assets", fileType, purpose });

test("automatic video mode covers text, first frame, first-last frame and semantic multimodal references", () => {
  assert.equal(resolveVideoMode({ trackId: 1, modeIntent: "auto", capabilities, references: [] }).resolvedMode, "text");
  assert.equal(resolveVideoMode({ trackId: 1, modeIntent: "auto", capabilities, references: [ref(1, "image", "first_frame")] }).resolvedMode, "singleImage");
  assert.equal(resolveVideoMode({ trackId: 1, modeIntent: "auto", capabilities, references: [ref(2, "image", "last_frame"), ref(1, "image", "first_frame")] }).resolvedMode, "startEndRequired");
  const semantic = [ref(11, "image", "identity_reference"), ref(12, "image", "style_reference"), ref(13, "video", "motion_reference"), ref(14, "audio", "audio_reference")];
  const resolved = resolveVideoMode({ trackId: 1, modeIntent: "auto", capabilities, references: semantic });
  assert.deepEqual(resolved.resolvedMode, multi); assert.deepEqual(resolved.resolvedReferences, semantic); assert.deepEqual(resolved.referenceSummary, { total: 4, image: 2, video: 1, audio: 1, purposes: { first_frame: 0, last_frame: 0, identity_reference: 1, style_reference: 1, motion_reference: 1, audio_reference: 1 } });
});

test("manual mode has priority but unsupported or lossy selections fail explicitly", () => {
  assert.equal(resolveVideoMode({ trackId: 1, modeIntent: "endFrameOptional", capabilities, references: [ref(1, "image", "first_frame")] }).resolvedMode, "endFrameOptional");
  assert.throws(() => resolveVideoMode({ trackId: 1, modeIntent: "text", capabilities, references: [ref(1, "image", "first_frame")] }), (error: any) => error instanceof VideoModeResolutionError && error.code === "VIDEO_MODE_INCOMPATIBLE");
  assert.throws(() => resolveVideoMode({ trackId: 1, modeIntent: "singleImage", capabilities: { mode: ["text"] }, references: [ref(1, "image", "first_frame")] }), /不受当前模型支持/);
  const tooMany = [1, 2, 3, 4, 5].map((id) => ref(10 + id, "image", "identity_reference"));
  assert.throws(() => resolveVideoMode({ trackId: 1, modeIntent: "auto", capabilities, references: tooMany }), /未降级为文生视频/);
});

test("last-frame-only intent requires a model that explicitly supports optional first frame", () => {
  assert.equal(resolveVideoMode({ trackId: 1, modeIntent: "auto", capabilities, references: [ref(2, "image", "last_frame")] }).resolvedMode, "startFrameOptional");
  assert.throws(() => resolveVideoMode({ trackId: 1, modeIntent: "auto", capabilities: { mode: ["text", "singleImage"] }, references: [ref(2, "image", "last_frame")] }), /未丢弃素材/);
});

test("official Seedance 2.x audio-only selection is rejected during automatic preview", () => {
  assert.throws(() => resolveVideoMode({ trackId: 1, modeIntent: "auto", capabilities: { modelName: "doubao-seedance-2-5-260628", mode: [multi] }, references: [ref(14, "audio", "audio_reference")] }), (error: any) => error.code === "VIDEO_MODE_INCOMPATIBLE" && /仅输入音频/.test(error.message));
  assert.deepEqual(resolveVideoMode({ trackId: 1, modeIntent: "auto", capabilities: { modelName: "another-provider-model", mode: [["audioReference:2"]] }, references: [ref(14, "audio", "audio_reference")] }).resolvedMode, ["audioReference:2"]);
});
