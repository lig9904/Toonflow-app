import test from "node:test";
import assert from "node:assert/strict";
import { textExecutionOptions } from "../src/lib/textExecutionOptions";

test("role configuration cannot enlarge a caller's output budget", () => {
  assert.deepEqual(textExecutionOptions({ maxOutputTokens: 400 }, { maxOutputTokens: 12000 }), { maxOutputTokens: 400 });
  assert.deepEqual(textExecutionOptions({ maxOutputTokens: 12000 }, { maxOutputTokens: 400 }), { maxOutputTokens: 400 });
});
test("explicit temperature zero is preserved for both caller and role configuration", () => {
  assert.equal(textExecutionOptions({ temperature: 0 }, { temperature: 0.8 }).temperature, 0);
  assert.equal(textExecutionOptions({}, { temperature: 0 }).temperature, 0);
  assert.equal(textExecutionOptions({}, { temperature: null }).temperature, undefined);
});
