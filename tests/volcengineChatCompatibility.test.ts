import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { withVolcengineChatCompatibility } from "../src/lib/volcengineChatCompatibility";

const modelId = "doubao-seed-2-1-260428";
const encrypted = "opaque-ark-signed-fixture==";
const tools = { lookup: tool({ inputSchema: z.object({ city: z.string() }), execute: async () => ({ temperature: 23 }) }) };
const completion = (message: unknown, finish_reason = "stop") => ({ id: "chat-fixture", object: "chat.completion", created: 1, model: modelId, choices: [{ index: 0, message, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 7 } } });
const call = { id: "call-one", type: "function", function: { name: "lookup", arguments: '{"city":"Shanghai"}' } };
function createFixture(wrapped: boolean, reasoning = "short summary") {
  const requests: any[] = [];
  const provider = createOpenAICompatible({ name: "volcengine", baseURL: "https://ark.invalid/api/v3", apiKey: "fixture", fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    return Response.json(requests.length === 1 ? completion({ role: "assistant", content: null, reasoning_content: reasoning, encrypted_content: encrypted, tool_calls: [call] }, "tool_calls") : completion({ role: "assistant", content: "23 degrees" }));
  } });
  const original = provider.chatModel(modelId);
  return { requests, model: wrapped ? withVolcengineChatCompatibility(original) : original };
}
test("installed SDK already returns reasoning_content but loses encrypted_content without compatibility", async () => {
  const fixture = createFixture(false);
  await generateText({ model: fixture.model, prompt: "temperature?", tools, stopWhen: stepCountIs(2), maxOutputTokens: 42, maxRetries: 0 });
  const assistant = fixture.requests[1].messages.find((message: any) => message.role === "assistant");
  assert.equal(assistant.reasoning_content, "short summary"); assert.equal(assistant.encrypted_content, undefined);
  assert.equal(fixture.requests[0].max_tokens, 42); assert.equal(fixture.requests[0].max_completion_tokens, undefined);
});
test("generateText tool loop replays opaque encrypted state while preserving visible reasoning and usage", async () => {
  const fixture = createFixture(true);
  const result = await generateText({ model: fixture.model, prompt: "temperature?", tools, stopWhen: stepCountIs(2), maxOutputTokens: 42, maxRetries: 0 });
  const assistant = fixture.requests[1].messages.find((message: any) => message.role === "assistant");
  assert.equal(assistant.encrypted_content, encrypted); assert.equal(assistant.reasoning_content, "short summary");
  assert.equal(assistant.tool_calls[0].id, "call-one"); assert.equal(result.text, "23 degrees");
  assert.equal(result.steps[0].usage.outputTokens, 12); assert.equal(result.steps[0].usage.outputTokenDetails.reasoningTokens, 7);
  assert.equal(result.steps[0].reasoningText, "short summary"); assert.ok(!result.text.includes(encrypted));
  assert.equal(fixture.requests[0].max_tokens, 42); // Budget field mapping belongs to provider fetch, not this wrapper.
});
test("encrypted-only responses survive a persisted response.messages replay without a process cache", async () => {
  const first = createFixture(true, "");
  const result = await generateText({ model: first.model, prompt: "temperature?", tools, stopWhen: stepCountIs(1), maxRetries: 0 });
  const savedMessages = JSON.parse(JSON.stringify(result.response.messages));
  const requests: any[] = [];
  const fresh = createOpenAICompatible({ name: "volcengine", baseURL: "https://ark.invalid/api/v3", fetch: async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json(completion({ role: "assistant", content: "done" })); } });
  await generateText({ model: withVolcengineChatCompatibility(fresh.chatModel(modelId)), messages: [{ role: "user", content: "temperature?" }, ...savedMessages], tools, maxRetries: 0 });
  const assistant = requests[0].messages.find((message: any) => message.role === "assistant");
  assert.equal(assistant.encrypted_content, encrypted); assert.ok(!String(assistant.content).includes(encrypted));
});
function streamResponse(chunks: unknown[]) {
  const text = chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 19) controller.enqueue(bytes.slice(i, i + 19)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
}
const delta = (value: unknown, finish_reason: string | null = null) => ({ id: "stream-fixture", created: 1, model: modelId, choices: [{ index: 0, delta: value, finish_reason }] });
for (const withSummary of [true, false]) test(`streamText encrypted-only SSE event is replayed after tools (summary=${withSummary})`, async () => {
  const requests: any[] = [];
  const provider = createOpenAICompatible({ name: "volcengine", baseURL: "https://ark.invalid/api/v3", fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return streamResponse(requests.length === 1 ? [delta({ role: "assistant" }), ...(withSummary ? [delta({ reasoning_content: "summary part" })] : []), delta({ encrypted_content: encrypted, content: "", reasoning_content: "" }), delta({ tool_calls: [{ index: 0, ...call }] }), delta({}, "tool_calls")] : [delta({ role: "assistant", content: "done" }), delta({}, "stop")]);
  } });
  const result = streamText({ model: withVolcengineChatCompatibility(provider.chatModel(modelId)), prompt: "lookup", tools, stopWhen: stepCountIs(2), maxRetries: 0 });
  await result.consumeStream();
  assert.equal(await result.text, "done");
  const assistant = requests[1].messages.find((message: any) => message.role === "assistant");
  assert.equal(assistant.encrypted_content, encrypted);
  assert.equal(assistant.reasoning_content, withSummary ? "summary part" : undefined);
  const firstStep = (await result.steps)[0]; assert.ok(!String(firstStep.reasoningText).includes(encrypted));
});
test("another model and an independent conversation never inherit opaque state", async () => {
  const fixture = createFixture(true); const output = await generateText({ model: fixture.model, prompt: "lookup", tools, stopWhen: stepCountIs(1), maxRetries: 0 });
  const requests: any[] = [];
  const provider = createOpenAICompatible({ name: "volcengine", baseURL: "https://ark.invalid/api/v3", fetch: async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json(completion({ role: "assistant", content: "done" })); } });
  await generateText({ model: withVolcengineChatCompatibility(provider.chatModel("different-model")), messages: [{role:"user",content:"lookup"}, ...output.response.messages], tools, maxRetries: 0 });
  assert.equal(requests[0].messages.find((message: any) => message.role === "assistant").encrypted_content, undefined);
  await generateText({ model: fixture.model, prompt: "independent conversation", maxRetries: 0 });
  assert.ok(fixture.requests[1].messages.every((message: any) => !message.encrypted_content));
});

test("multiple encrypted-only deltas concatenate exactly, including a late delta after reasoning-end", async () => {
  const requests: any[] = [];
  const provider = createOpenAICompatible({ name: "volcengine", baseURL: "https://ark.invalid/api/v3", fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return streamResponse(requests.length === 1 ? [delta({ reasoning_content: "summary" }), delta({ encrypted_content: "opaque-" }), delta({ content: "Checking" }), delta({ encrypted_content: "signed-" }), delta({ encrypted_content: "state==" }), delta({ tool_calls: [{ index: 0, ...call }] }), delta({}, "tool_calls")] : [delta({ content: "done" }), delta({}, "stop")]);
  } });
  const result = streamText({ model: withVolcengineChatCompatibility(provider.chatModel(modelId)), prompt: "lookup", tools, stopWhen: stepCountIs(2), maxRetries: 0 });
  await result.consumeStream();
  const assistant = requests[1].messages.find((message: any) => message.role === "assistant");
  assert.equal(assistant.encrypted_content, "opaque-signed-state=="); assert.equal(assistant.content, "Checking"); assert.equal(assistant.reasoning_content, "summary");
});
