import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { encodeReviewImage, imageReviewSdkContent } from "../src/services/imageReviews/media";
import { imageReviewResultSchema } from "../src/services/imageReviews";
import { diagnoseImageReviewFailure, ImageReviewDiagnosticError, parseImageReviewOutput } from "../src/services/imageReviews/output";

test("actual AI SDK transports output and reference bytes as ordered inline images without a URL download", async () => {
  const output = await encodeReviewImage(await sharp({ create: { width: 16, height: 8, channels: 3, background: "red" } }).png().toBuffer());
  const reference = await encodeReviewImage(await sharp({ create: { width: 16, height: 8, channels: 3, background: "blue" } }).png().toBuffer());
  let calls = 0, downloadUrls = 0, sent: any;
  const provider = createOpenAICompatible({ name: "fixture", baseURL: "https://fixture.invalid/v1", fetch: async (_url, init) => {
    calls++; sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "vision-fixture", object: "chat.completion", created: 1, model: "deepseek-flash", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ summary: "看到了实际输出与参考", findings: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 25, total_tokens: 45 } }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const content = imageReviewSdkContent([{ type: "text", text: "生成图" }, { type: "image", image: output.dataUrl }, { type: "text", text: "参考图1" }, { type: "image", image: reference.dataUrl }]);
  assert(content[1].type === "image" && content[1].image instanceof Uint8Array);
  const result = await generateText({ model: provider.chatModel("deepseek-flash"), system: "Return JSON.", messages: [{ role: "user", content }], maxOutputTokens: 4096, maxRetries: 0,
    experimental_download: async (urls) => { downloadUrls += urls.length; assert.equal(urls.length, 0, "review must not enter URL downloader"); return []; },
  });
  assert.equal(calls, 1); assert.equal(downloadUrls, 0); assert.equal(result.finishReason, "stop");
  const parts = sent.messages.find((message: any) => message.role === "user").content;
  assert.deepEqual(parts.map((part: any) => part.type), ["text", "image_url", "text", "image_url"]);
  assert.equal(parts[0].text, "生成图"); assert.equal(parts[2].text, "参考图1");
  assert.equal(parts[1].image_url.url, output.dataUrl); assert.equal(parts[3].image_url.url, reference.dataUrl);
  assert.equal(sent.max_tokens, 4096);
});

test("complete object envelopes and nullable optional evidence fields are compatible without guessing required fields", () => {
  const value = { summary: "图像存在问题", findings: [{ code: "COUNT", severity: "warning", message: "图中多出一个对象", confidence: null, referenceLabel: null }] };
  for (const text of [JSON.stringify(value), `\uFEFF\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, `以下为核验结果：\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n核验结束。`]) {
    assert.deepEqual(parseImageReviewOutput({ kind: "image-review-model-response", text, finishReason: "stop", usage: { outputTokens: 120 }, expectedImageCount: 2, sentImageCount: 2 }, imageReviewResultSchema).value, value);
  }
  for (const text of ['{"summary":"unfinished', '{"summary":"ok"} {"findings":[]}', '```json\n{"summary":"ok",}\n```']) {
    assert.throws(() => parseImageReviewOutput(text, imageReviewResultSchema), (error: unknown) => error instanceof ImageReviewDiagnosticError && error.diagnostics.code === "REVIEW_OUTPUT_JSON");
  }
  assert.throws(() => parseImageReviewOutput({ summary: "missing findings" }, imageReviewResultSchema), (error: unknown) => error instanceof ImageReviewDiagnosticError && error.diagnostics.code === "REVIEW_OUTPUT_SCHEMA" && error.diagnostics.fields?.[0].path === "findings");
  assert.throws(() => parseImageReviewOutput({ summary: "test", findings: [{ code: "X", severity: "unknown", message: "x" }] }, imageReviewResultSchema), (error: unknown) => error instanceof ImageReviewDiagnosticError && error.diagnostics.fields?.[0].path === "findings.[0].severity");
});

test("truncation, filtered results and SDK-dropped images cannot produce a successful visual review", () => {
  for (const [finishReason, code] of [["length", "REVIEW_OUTPUT_LIMIT"], ["content-filter", "REVIEW_OUTPUT_FILTERED"], ["tool-calls", "REVIEW_OUTPUT_INCOMPLETE"]]) {
    assert.throws(() => parseImageReviewOutput({ kind: "image-review-model-response", text: '{"summary":"valid JSON but incomplete call","findings":[]}', finishReason, maxOutputTokens: 4096 }, imageReviewResultSchema), (error: unknown) => error instanceof ImageReviewDiagnosticError && error.diagnostics.code === code && error.diagnostics.finishReason === finishReason);
  }
  assert.throws(() => parseImageReviewOutput({ kind: "image-review-model-response", text: '{"summary":"text-only claimed success","findings":[]}', finishReason: "stop", expectedImageCount: 2, sentImageCount: 0 }, imageReviewResultSchema), (error: unknown) => error instanceof ImageReviewDiagnosticError && error.diagnostics.code === "REVIEW_VISION_NOT_SENT");
});

test("SDK and HTTP failure diagnostics preserve only allowlisted names/status/codes, never secret bodies or URLs", () => {
  const failure = { name: "AI_APICallError", message: "private-secret-token", statusCode: 400, url: "https://private.invalid", responseHeaders: { authorization: "private-header" }, responseBody: JSON.stringify({ error: { code: "invalid_parameter", message: "private-input" } }) };
  const diagnostics = diagnoseImageReviewFailure(failure, "model_request");
  assert.equal(diagnostics.code, "REVIEW_REQUEST_REJECTED"); assert.equal(diagnostics.httpStatus, 400); assert.equal(diagnostics.providerCode, "invalid_parameter"); assert.equal(diagnostics.errorName, "AI_APICallError");
  assert(!JSON.stringify(diagnostics).includes("private"));
  const download = diagnoseImageReviewFailure({ name: "AI_DownloadError", message: "URL scheme must be http or https, got data: private-image" });
  assert.equal(download.code, "REVIEW_IMAGE_TRANSPORT"); assert.equal(download.errorName, "AI_DownloadError"); assert(!JSON.stringify(download).includes("private-image"));
});
