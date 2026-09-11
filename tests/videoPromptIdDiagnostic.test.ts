import test from "node:test";
import assert from "node:assert/strict";
import { videoPromptIdDiagnostic } from "../src/lib/videoPromptIdDiagnostic";

test("prompt ID diagnostics identify missing fields without logging arbitrary input", () => {
  const result = videoPromptIdDiagnostic("/api/production/workbench/generateVideoPrompt", {
    projectId: 4, scriptId: null, trackId: "secret-must-not-appear", prompt: "private script", apiKey: "sensitive-key", idempotencyKey: "private-token",
  });
  assert.deepEqual(result?.ids, [
    { field: "projectId", kind: "number", valid: true, value: 4 },
    { field: "scriptId", kind: "null", valid: false },
    { field: "trackId", kind: "string", valid: false },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret-must|private|sensitive/);
  assert.equal(videoPromptIdDiagnostic("/api/login/login", {}), undefined);
});

test("batch diagnostics preserve field indices and bound output", () => {
  const result = videoPromptIdDiagnostic("/api/production/workbench/batchGeneratePrompt", { projectId: "4", scriptId: 5, trackData: [{ trackId: 21 }, {}, { trackId: 0 }] });
  assert.deepEqual((result?.ids as any[]).slice(-2), [
    { field: "trackData[1].trackId", kind: "undefined", valid: false },
    { field: "trackData[2].trackId", kind: "number", valid: false, value: 0 },
  ]);
});
