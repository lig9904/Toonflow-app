import test from "node:test";
import assert from "node:assert/strict";
import { matchVideoGenerationDuration, videoTailHoldInstruction } from "../src/lib/videoGenerationTiming";

test("generation timing rounds upward for the selected quality without modifying the script", () => {
  const model = { durationResolutionMap: [{ duration: [4, 8], resolution: ["480p"] }, { duration: [6], resolution: ["720p"] }] };
  assert.equal(matchVideoGenerationDuration(model, 3, "480p"), 4);
  assert.equal(matchVideoGenerationDuration(model, 5, "480p"), 8);
  assert.equal(matchVideoGenerationDuration(model, 5, "720p"), 6);
  assert.throws(() => matchVideoGenerationDuration(model, 9, "480p"), /拆分片段/);
  assert.match(videoTailHoldInstruction(3, 4), /前 3 秒内完成/);
  assert.match(videoTailHoldInstruction(3, 4), /尾部 1 秒/);
  assert.equal(videoTailHoldInstruction(4, 4), "");
});
