import test from "node:test";
import assert from "node:assert/strict";
import { generateText, NoOutputGeneratedError, Output } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3FinishReason } from "@ai-sdk/provider";
import { z } from "zod";
import { readStructuredModelOutput, StructuredModelOutputError } from "../src/lib/structuredModelOutput";

const schema = z.object({ scriptPlan: z.string() }).strict();
function model(reason: LanguageModelV3FinishReason["unified"], text: string, tokens = 5100) {
  return new MockLanguageModelV3({ doGenerate: {
    content: [{ type: "text", text }], finishReason: { unified: reason, raw: reason }, warnings: [],
    usage: { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: tokens, text: tokens - 100, reasoning: 100 } },
  } });
}
const request = { role: "productionAgent:directorPlanAgent", schema, maxOutputTokens: 5100 };

test("SDK length completion exposes a generic throwing getter; wrapper preserves the real reason and usage", async () => {
  const old = await generateText({ model: model("length", '{"scriptPlan":"partial'), prompt: "fixture", output: Output.object({ schema }), maxRetries: 0 });
  assert.throws(() => old.output, NoOutputGeneratedError);
  const provider = model("length", '{"scriptPlan":"partial secret-fixture-content');
  await assert.rejects(readStructuredModelOutput(request, (onFinish) => generateText({ model: provider, prompt: "fixture", output: Output.object({ schema }), maxOutputTokens: request.maxOutputTokens, maxRetries: 0, onFinish })), (error: unknown) => {
    assert(error instanceof StructuredModelOutputError);
    assert.equal(error.code, "MODEL_OUTPUT_LIMIT");
    assert.equal(error.diagnostics.finishReason, "length");
    assert.equal(error.diagnostics.outputTokens, 5100);
    assert.equal(error.diagnostics.reasoningTokens, 100);
    assert.match(error.message, /导演计划.*5100/);
    assert(!JSON.stringify(error).includes("secret-fixture-content"));
    return true;
  });
  assert.equal(provider.doGenerateCalls.length, 1, "No implicit paid retry");
});

test("complete-looking JSON with a length finish is not committed as a complete model result", async () => {
  await assert.rejects(readStructuredModelOutput(request, (onFinish) => generateText({ model: model("length", '{"scriptPlan":"apparently complete"}'), prompt: "fixture", output: Output.object({ schema }), onFinish })), (error: unknown) => error instanceof StructuredModelOutputError && error.code === "MODEL_OUTPUT_LIMIT");
});

test("schema mismatch retains counters from onFinish without retaining raw data", async () => {
  await assert.rejects(readStructuredModelOutput(request, (onFinish) => generateText({ model: model("stop", '{"wrong":"private fixture"}', 120), prompt: "fixture", output: Output.object({ schema }), onFinish })), (error: unknown) => {
    assert(error instanceof StructuredModelOutputError);
    assert.equal(error.code, "MODEL_OUTPUT_FORMAT"); assert.equal(error.diagnostics.outputTokens, 120);
    assert(!JSON.stringify(error).includes("private fixture")); return true;
  });
});

test("filtered output is distinguished and valid structured output remains unchanged", async () => {
  await assert.rejects(readStructuredModelOutput(request, (onFinish) => generateText({ model: model("content-filter", "", 100), prompt: "fixture", output: Output.object({ schema }), onFinish })), (error: unknown) => error instanceof StructuredModelOutputError && error.code === "MODEL_OUTPUT_FILTERED");
  const result = await readStructuredModelOutput(request, (onFinish) => generateText({ model: model("stop", '{"scriptPlan":"safe plan"}', 120), prompt: "fixture", output: Output.object({ schema }), onFinish }));
  assert.deepEqual(result, { value: { scriptPlan: "safe plan" }, outputTokens: 120 });
});

test("diagnostics reflect the actual provider cap when role settings tighten it", async () => {
  const provider = model("length", "partial", 1000);
  const original = provider.doGenerate;
  provider.doGenerate = async (options) => ({ ...await original(options), request: { body: JSON.stringify({ max_tokens: 1000, private_value: "do-not-retain" }) } });
  await assert.rejects(readStructuredModelOutput(request, (onFinish) => generateText({ model: provider, prompt: "fixture", output: Output.object({ schema }), onFinish })), (error: unknown) => {
    assert(error instanceof StructuredModelOutputError);
    assert.equal(error.diagnostics.maxOutputTokens, 1000);
    assert(!JSON.stringify(error).includes("do-not-retain")); return true;
  });
});
