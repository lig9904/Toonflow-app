import test from "node:test";
import assert from "node:assert/strict";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { MockLanguageModelV3 } from "ai/test";
import { invokeVideoPromptReview, classifyVideoPromptReviewFailure } from "../src/services/videoPromptReviewRuntime";
import { reviewGeneratedVideoPrompt, videoPromptReviewSchema } from "../src/services/videoPromptReview";
import type { VideoPromptJob } from "../src/services/videoPromptJobs";

const expected = { findings: [], summary: "当前源对白与身份保持一致" };
const request = { system: "核对源分镜、身份及当前人工意图，只做必要最小修正。", input: { prompt: "fixture draft", source: [{ id: 1, duration: 1.5 }] }, schema: videoPromptReviewSchema };
function fixtureJob(): VideoPromptJob {
  return { id: "review-wire-fixture", projectId: 1, scriptId: 1, trackId: 1, model: "fixture:video", mode: "text", state: "running", trackVersion: 0,
    sourceSnapshot: [{ id: 1, prompt: "非人类幼态神兽的倒影", duration: 1.5 }], referenceSnapshot: {}, referenceLabels: [], promptInput: "fixture",
    compositionSnapshot: { system: "generation", reviewSystem: "review", visualManual: "", versions: [], context: { model: "fixture:video", mode: "text", actualMode: "text", scriptDuration: 1.5, generation: { duration: 2, resolution: "480p", audio: false }, parameterSource: "fixture", capabilities: {} } } };
}

for (const supportsStructuredOutputs of [false, true]) {
  test(`real OpenAI-compatible SDK receives an explicit review schema with native schema support=${supportsStructuredOutputs}`, async () => {
    let sent: any, calls = 0;
    const provider = createOpenAICompatible({ name: "fixture", baseURL: "https://fixture.invalid/v1", supportsStructuredOutputs, fetch: async (_url, init) => {
      calls += 1; sent = JSON.parse(String(init?.body));
      // This provider fixture only knows the schema when it is actually present in the request.
      const system = sent.messages.find((message: any) => message.role === "system")?.content;
      const jsonSchema = JSON.parse(system.split("OUTPUT_JSON_SCHEMA\n")[1]);
      assert.equal(jsonSchema.type, "object");
      assert.deepEqual(jsonSchema.required, ["findings", "summary"]);
      assert.deepEqual(jsonSchema.properties.findings.items.properties.severity.enum, ["error", "warning", "info"]);
      assert.equal(jsonSchema.properties.correctedPrompt.type, "string");
      return new Response(JSON.stringify({ id: "fixture-completion", object: "chat.completion", created: 1, model: "json-only-model", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(expected) }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 40, total_tokens: 90 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
    const result = await invokeVideoPromptReview(request, (options) => { assert.equal(options.maxRetries, 0); assert.equal(options.tools, undefined); return generateText({ ...options, model: provider.chatModel("json-only-model") }); }, 4096);
    assert.deepEqual(result, expected);
    assert.equal(sent.response_format.type, supportsStructuredOutputs ? "json_schema" : "json_object");
    assert.equal(sent.max_tokens, 4096); assert.equal(calls, 1);
  });
}

for (const scenario of [
  { reason: "length" as const, text: '{"summary":"private-truncated-body', code: "MODEL_OUTPUT_LIMIT" },
  { reason: "stop" as const, text: '{"unexpected":"private-invalid-body"}', code: "MODEL_OUTPUT_FORMAT" },
  { reason: "content-filter" as const, text: "private-filtered-body", code: "MODEL_OUTPUT_FILTERED" },
]) {
  test(`review preserves the draft and safe ${scenario.code} diagnostics from real SDK output errors`, async () => {
    const provider = new MockLanguageModelV3({ doGenerate: {
      content: [{ type: "text", text: scenario.text }], finishReason: { unified: scenario.reason, raw: scenario.reason }, warnings: [],
      usage: { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 300, text: 200, reasoning: 100 } },
      request: { body: JSON.stringify({ max_tokens: 512, secret: "private-key-fixture" }) },
    } });
    const result = await reviewGeneratedVideoPrompt(fixtureJob(), "非人类幼态神兽的倒影", (input) => invokeVideoPromptReview(input, (options) => generateText({ ...options, model: provider }), 4096));
    assert.equal(result.prompt, "非人类幼态神兽的倒影"); assert.equal(result.review.revised, false); assert.equal(result.review.status, "failed");
    assert.equal(result.review.failure?.code, scenario.code);
    assert.equal(result.review.failure?.finishReason, scenario.reason);
    assert.equal(result.review.failure?.maxOutputTokens, 512);
    assert.equal(result.review.failure?.outputTokens, 300); assert.equal(result.review.failure?.reasoningTokens, 100);
    assert.equal(result.review.failure?.textCharacters, scenario.text.length);
    assert.match(result.review.findings[0].message, new RegExp(scenario.code));
    assert.doesNotMatch(JSON.stringify(result.review), /private-/);
    assert.equal(provider.doGenerateCalls.length, 1, "No automatic retry or media generation");
  });
}

test("a rejected provider request records status without response body or credentials and is never retried", async () => {
  let calls = 0;
  const provider = createOpenAICompatible({ name: "fixture", baseURL: "https://fixture.invalid/v1", fetch: async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "private-response-with-key-fixture" } }), { status: 429, headers: { "content-type": "application/json" } });
  } });
  const result = await reviewGeneratedVideoPrompt(fixtureJob(), "原稿保持", (input) => invokeVideoPromptReview(input, (options) => generateText({ ...options, model: provider.chatModel("fixture-model") })));
  assert.equal(result.review.failure?.code, "MODEL_REQUEST_REJECTED"); assert.equal(result.review.failure?.httpStatus, 429);
  assert.doesNotMatch(JSON.stringify(result.review), /private-|fixture.invalid/); assert.equal(calls, 1);
});

test("unclassified errors are never persisted verbatim", () => {
  assert.deepEqual(classifyVideoPromptReviewFailure(new Error("Authorization: secret fixture")), { code: "REVIEW_INTERNAL_ERROR" });
  const timeout = new Error("private endpoint"); timeout.name = "TimeoutError";
  assert.deepEqual(classifyVideoPromptReviewFailure(timeout), { code: "MODEL_REQUEST_TIMEOUT" });
});
