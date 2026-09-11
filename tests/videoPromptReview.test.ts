import test from "node:test";
import assert from "node:assert/strict";
import { referenceLabelFindings } from "../src/lib/videoPromptContract";
import { actualVideoPromptMode, effectiveVideoGeneration, selectVideoPromptReferences } from "../src/services/videoPromptComposition";
import { reviewGeneratedVideoPrompt } from "../src/services/videoPromptReview";
import type { VideoPromptJob } from "../src/services/videoPromptJobs";

const capabilities = { mode: ["text", "singleImage", "startEndRequired", ["imageReference:2", "audioReference:1"]], audio: "optional" as const, durationResolutionMap: [{ duration: [2, 4, 6], resolution: ["480p", "720p"] }] };
function job(): VideoPromptJob { return { id: "fixture", projectId: 1, scriptId: 2, trackId: 3, model: "fixture:seedance-2", mode: "text", state: "running", trackVersion: 0, referenceLabels: [], referenceSnapshot: { linkedAssets: [{ name: "螭吻", type: "role", describe: "非人类幼态神兽" }, { name: "童童", type: "role", describe: "明确八岁儿童" }] }, sourceSnapshot: [{ id: 1, duration: 1.5, prompt: "螭吻是非人类幼态神兽，童童是八岁儿童。镜中倒影同框，月光，用户明确要求配乐。", videoDesc: "画外音（童童）：别动，我会回来。" }], promptInput: "source", compositionSnapshot: { system: "shared", reviewSystem: "review", visualManual: "style", versions: [{ key: "review.videoPromptReview", version: "v1" }], context: { model: "fixture:seedance-2", mode: "text", actualMode: "text", scriptDuration: 1.5, generation: { duration: 2, resolution: "480p", audio: false }, parameterSource: "selection", capabilities } } }; }

test("actual mode wins over a model-family name; 1.5s script uses registered durations", () => {
  assert.equal(actualVideoPromptMode("text", 0), "text");
  assert.equal(actualVideoPromptMode("singleImage", 1), "firstFrame");
  assert.equal(actualVideoPromptMode("endFrameOptional", 1), "firstFrame");
  assert.equal(actualVideoPromptMode("startFrameOptional", 1), "firstFrame");
  assert.equal(actualVideoPromptMode("startEndRequired", 2), "firstLastFrame");
  assert.equal(actualVideoPromptMode('["imageReference:2","audioReference:1"]', 3), "multiReference");
  assert.equal(effectiveVideoGeneration(capabilities, 1.5).generation.duration, 2);
  assert.equal(effectiveVideoGeneration(capabilities, 2, { duration: 4, resolution: "720p", audio: true }).generation.duration, 4);
  assert.throws(() => effectiveVideoGeneration(capabilities, 1.5, { duration: 3 }), /不受/);
});

test("reference labels preserve typed independent numbering and reject invented text refs", () => {
  assert.equal(referenceLabelFindings("@图片1 @音频1 @图片2 @视频1", ["@图片1", "@音频1", "@图片2", "@视频1"]).length, 0);
  assert.equal(referenceLabelFindings("@图1 @图片9", ["@图片1"]).length, 2);
  assert.equal(referenceLabelFindings("@图片1", []).length, 1);
});

test("shared reference selection includes bound role audio and obeys typed limits", () => {
  const inventory = {
    storyboards: [{ id: 11, trackId: 3, filePath: "/a.png" }, { id: 12, trackId: 3, filePath: "/b.png" }],
    linkedAssets: [{ storyboardId: 11, id: 21, assetsId: null, type: "role", filePath: "/role.png", storedFileType: "image" }],
    boundAudio: [{ roleAssetId: 21, familyId: 30, id: 31, name: "voice", describe: "", prompt: "", filePath: "/voice.mp3", version: 2 }],
  };
  assert.deepEqual(selectVideoPromptReferences(["imageReference:1", "audioReference:1"], inventory, 3), [
    { id: 11, sources: "storyboard", fileType: "image" }, { id: 31, sources: "assets", fileType: "audio" },
  ]);
  assert.deepEqual(selectVideoPromptReferences("startEndRequired", inventory, 3).map((item) => item.id), [11, 12]);
});

test("semantic review gets real source identities, intent, timing and audio; one minimal repair", async () => {
  const fixture = job(); let calls = 0;
  const corrected = "螭吻是非人类幼态神兽，童童是八岁儿童，镜中倒影同框，月光与配乐按用户要求。画外音（童童）：别动，我会回来。音频关闭，台词作为表演依据。";
  const result = await reviewGeneratedVideoPrompt(fixture, "螭吻与镜中倒影，月光与配乐。", async ({ input }) => {
    calls += 1;
    assert.match(JSON.stringify(input), /非人类幼态神兽/);
    assert.match(JSON.stringify(input), /八岁儿童/);
    assert.match(JSON.stringify(input), /1.5/);
    return { summary: "补回漏掉的对白", findings: [{ code: "MISSING_DIALOGUE", severity: "error", message: "童童画外对白遗漏", shotId: 1 }], correctedPrompt: corrected };
  });
  assert.equal(result.prompt, corrected); assert.equal(result.review.revised, true); assert.equal(calls, 1);
  assert.equal(result.review.findings.find((finding) => finding.code === "MISSING_DIALOGUE")?.severity, "error");
  assert.match(result.review.summary, /未经再次语义复核/);
});

test("aesthetic uncertainty never rewrites or blocks and a failed semantic call is not retried", async () => {
  const fixture = job(); const draft = "画外音（童童）：别动，我会回来。";
  const aesthetic = await reviewGeneratedVideoPrompt(fixture, draft, async () => ({ summary: "审美不确定", findings: [{ code: "AESTHETIC", severity: "warning", message: "可能需要更柔和" }], correctedPrompt: "完全不同的故事" }));
  assert.equal(aesthetic.prompt, draft); assert.equal(aesthetic.review.revised, false);
  let calls = 0;
  const failed = await reviewGeneratedVideoPrompt(fixture, draft, async () => { calls += 1; throw new Error("fixture timeout"); });
  assert.equal(failed.prompt, draft); assert.equal(failed.review.status, "failed"); assert.equal(calls, 1);
  const invalidRepair = await reviewGeneratedVideoPrompt(fixture, draft, async () => ({ summary: "错误修正", findings: [{ code: "ERROR", severity: "error", message: "fixture" }], correctedPrompt: "@图片1 无对白" }));
  assert.equal(invalidRepair.prompt, draft); assert.equal(invalidRepair.review.revised, false);
  assert.equal(invalidRepair.review.findings.find((finding) => finding.code === "ERROR")?.severity, "error");
});

import { speakerFindings } from "../src/lib/videoPromptContract";
test("explicit offscreen speakers are checked even when the words survive", () => {
  assert(speakerFindings("画外音（童童）：别动。", "旁白：别动。").some((finding) => finding.code === "SPEAKER_CHANGED"));
  assert(speakerFindings("画外音（童童）：别动。", "童童说：别动。").some((finding) => finding.code === "OFFSCREEN_SPEECH_CHANGED"));
  assert.equal(speakerFindings("画外音（童童）：别动。", "童童在画外说：别动。").length, 0);
  assert.equal(speakerFindings("对白（童童，画外）：别动。", "童童在画外说：别动。", ["童童"]).length, 0);
});
