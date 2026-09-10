import test from "node:test";
import assert from "node:assert/strict";
import { textModelOutputLimit } from "../src/lib/textModelOutputLimit";

test("official DeepSeek output capability is independent of the run or context window", () => {
  assert.equal(textModelOutputLimit({ modelName: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com", configuredMaxOutputTokens: 0 }), 384000);
  assert.equal(textModelOutputLimit({ modelName: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com/v1" }), 384000);
  assert.equal(textModelOutputLimit({ modelName: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com", configuredMaxOutputTokens: 8192 }), 8192);
  assert.equal(textModelOutputLimit({ modelName: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com", declaredMaxOutputTokens: 1000000 }), 384000);
});

test("relays and unknown models use only their declared limit or provider default", () => {
  assert.equal(textModelOutputLimit({ modelName: "deepseek-v4-pro", baseUrl: "https://relay.invalid" }), undefined);
  assert.equal(textModelOutputLimit({ modelName: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com.relay.invalid" }), undefined);
  assert.equal(textModelOutputLimit({ modelName: "custom", declaredMaxOutputTokens: 24000, configuredMaxOutputTokens: 32000 }), 24000);
  assert.equal(textModelOutputLimit({ modelName: "custom", declaredMaxOutputTokens: "1000000", configuredMaxOutputTokens: 0 }), undefined);
});
