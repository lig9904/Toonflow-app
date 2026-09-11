import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { transform } from "sucrase";
import { VM } from "vm2";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
async function fixture(options: { fastTimeout?: boolean } = {}) {
  const source = await readFile(path.resolve(process.cwd(), "providers/agentsYun.ts"), "utf8");
  const javascript = transform(source, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const provider: Record<string, any> = {};
  const calls: Call[] = [];
  let handler: (call: Call) => Response | Promise<Response> = () => new Response("{}");
  const fetchMock = async (input: string, init: RequestInit = {}) => {
    const item = { url: String(input), method: init.method || "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(item); return handler(item);
  };
  new VM({ timeout: 0, eval: false, wasm: false, sandbox: { exports: provider, fetch: fetchMock, AbortController, setTimeout: options.fastTimeout ? ((handler: (...args: any[]) => void) => { queueMicrotask(handler); return 0; }) : setTimeout, clearTimeout, URL, Headers, Response, Buffer, logger: () => undefined, pollTask: async (fn: any) => fn() } }).run(javascript);
  const defaultBaseUrl = provider.vendor.inputValues.baseUrl;
  provider.vendor.inputValues.baseUrl = "https://agentsyun.example.test";
  provider.vendor.inputValues.apiKey = "agentsyun-local-key";
  return { provider, calls, defaultBaseUrl, setHandler: (next: any) => { handler = next; } };
}
const imageRef = (url = "https://media.example.test/ref.png") => ({ type: "image", sourceType: "url", url });
const videoRef = (url = "https://media.example.test/ref.mp4") => ({ type: "video", sourceType: "url", url });

describe("Agent云 provider contract", () => {
  it("exposes exactly three image and four Seedance video models with documented quality", async () => {
    const f = await fixture();
    assert.equal(f.defaultBaseUrl, "https://api.agentsyun.com/relay/v1");
    assert.equal(f.provider.vendor.id, "agentsYun");
    assert.deepEqual(f.provider.vendor.models.map((m: any) => m.modelName), ["Seedream-4.5", "Doubao-Seedream-4.5", "Doubao-Seedream-5.0-Lite", "Doubao-Seedance-2.0", "Doubao-Seedance-2.0-mini", "Doubao-Seedance-2.0-fast", "Doubao-Seedance-2.5"]);
    assert.deepEqual(f.provider.vendor.models[0].resolutions, ["2K", "4K"]);
    assert.deepEqual(f.provider.vendor.models[2].resolutions, ["2K", "3K", "4K"]);
    assert.deepEqual(f.provider.vendor.models[3].durationResolutionMap[0].resolution, ["480p", "720p", "1080p", "4k"]);
    assert.deepEqual(f.provider.vendor.models[4].durationResolutionMap[0].resolution, ["480p", "720p"]);
    assert.deepEqual(f.provider.vendor.models[6].durationResolutionMap[0].duration, Array.from({ length: 27 }, (_v, i) => i + 4));
    assert.equal(f.provider.vendor.models[6].referenceRatio, "adaptive");
    assert.equal(f.provider.synchronousImageRequestVersion, 1);
    assert.equal(f.provider.persistentVideoTaskVersion, 1);
  });

  it("sends synchronous single image requests with strict body and returns URL without task id", async () => {
    const f = await fixture();
    const model = f.provider.vendor.models[2];
    f.setHandler(() => new Response(JSON.stringify({ data: [{ url: "https://cdn.example.test/image.png" }] }), { status: 200 }));
    assert.deepEqual(await f.provider.synchronousImageRequest({ prompt: "a lighthouse", referenceList: [imageRef()], size: "3K", aspectRatio: "16:9", outputFormat: "png", optimize_prompt_options: { enabled: true } }, model), { outputUrl: "https://cdn.example.test/image.png" });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, "https://agentsyun.example.test/relay/v1/image/stellar/generations");
    assert.equal(f.calls[0].headers.authorization, "Bearer agentsyun-local-key");
    assert.equal(f.calls[0].body.sequential_image_generation, "disabled");
    assert.equal(f.calls[0].body.output_format, "png");
    assert.equal(f.calls[0].body.size, "3840x2160");
    assert.equal("optimize_prompt_options" in f.calls[0].body, false);
    assert.equal(f.calls[0].body.image, "https://media.example.test/ref.png");
  });

  it("accepts the documented full relay base path without duplicating it", async () => {
    const f = await fixture();
    f.provider.vendor.inputValues.baseUrl = "https://api.agentsyun.com/relay/v1";
    const model = f.provider.vendor.models[0];
    f.setHandler(() => new Response(JSON.stringify({ data: [{ url: "https://cdn.example.test/image.png" }] }), { status: 200 }));
    await f.provider.synchronousImageRequest({ prompt: "image", size: "2K", aspectRatio: "1:1" }, model);
    assert.equal(f.calls[0].url, "https://api.agentsyun.com/relay/v1/image/stellar/generations");
  });

  it("strictly maps b64 image responses and rejects malformed/empty data", async () => {
    const f = await fixture();
    const model = f.provider.vendor.models[0];
    f.setHandler(() => new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=", mime_type: "image/png" }] }), { status: 200 }));
    assert.deepEqual(await f.provider.synchronousImageRequest({ prompt: "image", size: "2K", aspectRatio: "1:1", responseFormat: "b64_json" }, model), { outputBase64: "iVBORw0KGgo=", mimeType: "image/png" });
    f.setHandler(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await assert.rejects(f.provider.imageRequest({ prompt: "image", size: "2K", aspectRatio: "1:1" }, model), /data 恰好包含 1 张/);
    f.setHandler(() => new Response(JSON.stringify({ message: "invalid request" }), { status: 400 }));
    await assert.rejects(f.provider.synchronousImageRequest({ prompt: "image", size: "2K", aspectRatio: "1:1" }, model), (error: any) => error.message.includes("HTTP 400") && error.submissionOutcome === "rejected");
    f.setHandler(() => new Response(JSON.stringify({ data: [{ url: "https://cdn.example.test/a.png" }, { url: "https://cdn.example.test/b.png" }] }), { status: 200 }));
    await assert.rejects(f.provider.synchronousImageRequest({ prompt: "image", size: "2K", aspectRatio: "1:1" }, model), /恰好包含 1 张/);
  });

  it("enforces image reference/output limits and no unsupported quality", async () => {
    const f = await fixture();
    const model = f.provider.vendor.models[0];
    await assert.rejects(f.provider.synchronousImageRequest({ prompt: "x", size: "3K", aspectRatio: "1:1" }, model), /不支持/);
    await assert.rejects(f.provider.synchronousImageRequest({ prompt: "x", size: "2K", aspectRatio: "1:1", referenceList: Array.from({ length: 15 }, () => imageRef()) }, model), /最多 14/);
    assert.equal(f.calls.length, 0);
  });

  it("accepts canonical PNG/JPEG/WebP image Data URLs and rejects bad magic or options", async () => {
    const f = await fixture();
    const model = f.provider.vendor.models[0];
    f.setHandler(() => new Response(JSON.stringify({ data: [{ url: "https://cdn.example.test/image.png" }] }), { status: 200 }));
    for (const base64 of ["iVBORw0KGgo=", "/9j/4AAQ", "UklGRgAAAABXRUJQ"]) {
      await f.provider.synchronousImageRequest({ prompt: "image", size: "2K", aspectRatio: "1:1", referenceList: [{ type: "image", sourceType: "base64", base64: `data:image/${base64 === "/9j/4AAQ" ? "jpeg" : base64.startsWith("Ukl") ? "webp" : "png"};base64,${base64}` }] }, model);
    }
    await assert.rejects(f.provider.synchronousImageRequest({ prompt: "image", size: "2K", aspectRatio: "1:1", referenceList: [{ type: "image", base64: "data:image/png;base64,AAAA" }] }, model), /MIME 与文件内容/);
    await assert.rejects(f.provider.synchronousImageRequest({ prompt: "image", size: "2K", aspectRatio: "1:1", outputFormat: "png" }, model), /仅 Doubao/);
    await assert.rejects(f.provider.synchronousImageRequest({ prompt: "image", size: "2K", aspectRatio: "1:1", responseFormat: "bad" as any }, model), /response_format/);
  });

  it("covers portrait size mapping and deadline across a stalled HTTP request", async () => {
    const f = await fixture();
    const model = f.provider.vendor.models[2];
    f.setHandler(() => new Response(JSON.stringify({ data: [{ url: "https://cdn.example.test/portrait.png" }] }), { status: 200 }));
    await f.provider.synchronousImageRequest({ prompt: "portrait", size: "2K", aspectRatio: "9:16" }, model);
    assert.equal(f.calls[0].body.size, "1440x2560");
    await f.provider.synchronousImageRequest({ prompt: "square", size: "2K", aspectRatio: "1:1" }, model);
    assert.equal(f.calls[1].body.size, "2048x2048");
    await f.provider.synchronousImageRequest({ prompt: "portrait 3k", size: "3K", aspectRatio: "9:16" }, model);
    assert.equal(f.calls[2].body.size, "2160x3840");
    await f.provider.synchronousImageRequest({ prompt: "portrait 4k", size: "4K", aspectRatio: "9:16" }, model);
    assert.equal(f.calls[3].body.size, "2880x5120");
    await f.provider.synchronousImageRequest({ prompt: "cinema", size: "2K", aspectRatio: "21:9" }, model);
    assert.equal(f.calls[4].body.size, "3024x1296");
    await assert.rejects(f.provider.synchronousImageRequest({ prompt: "bad ratio", size: "2K", aspectRatio: "5:7" }, model), /画面比例/);
    const stalled = await fixture({ fastTimeout: true });
    const stalledModel = stalled.provider.vendor.models[0];
    stalled.setHandler(() => new Promise<Response>(() => undefined));
    await assert.rejects(stalled.provider.synchronousImageRequest({ prompt: "portrait", size: "2K", aspectRatio: "9:16" }, stalledModel), /请求失败/);
  });

  it("submits and queries Seedance with the documented protocol and no duplicate POST", async () => {
    const f = await fixture();
    const model = f.provider.vendor.models[6];
    f.setHandler((call: { method: string }) => call.method === "POST" ? new Response(JSON.stringify({ task_id: "agentsyun-task-1" }), { status: 200 }) : new Response(JSON.stringify({ status: "succeeded", content: { video_url: "https://cdn.example.test/video.mp4" } }), { status: 200 }));
    assert.deepEqual(await f.provider.submitVideoTask({ prompt: "camera push", duration: 30, resolution: "1080p", aspectRatio: "9:16", audio: false, mode: "singleImage", referenceList: [imageRef()] }, model), { taskId: "agentsyun-task-1" });
    assert.deepEqual(await f.provider.queryVideoTask("agentsyun-task-1"), { status: "succeeded", outputUrl: "https://cdn.example.test/video.mp4" });
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
    assert.equal(f.calls[0].url, "https://agentsyun.example.test/relay/v1/video/seedance2/generations");
    assert.equal(f.calls[1].url, "https://agentsyun.example.test/relay/v1/video/seedance2/tasks/agentsyun-task-1");
    assert.equal(f.calls[0].body.ratio, "adaptive");
    assert.equal(f.calls[0].body.generate_audio, false);
  });

  it("keeps 2.0 quality/reference constraints and maps unknown statuses/errors", async () => {
    const f = await fixture();
    const model20 = f.provider.vendor.models[4];
    await assert.rejects(f.provider.submitVideoTask({ prompt: "x", duration: 5, resolution: "4k", aspectRatio: "16:9", mode: "text", referenceList: [] }, model20), /不支持 4k/);
    f.setHandler(() => new Response(JSON.stringify({ task_id: "agentsyun-20-multi" }), { status: 200 }));
    assert.deepEqual(await f.provider.submitVideoTask({ prompt: "x", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: ["imageReference:9", "videoReference:3", "audioReference:3"], referenceList: [imageRef(), videoRef()] }, model20), { taskId: "agentsyun-20-multi" });
    assert.deepEqual(f.calls[0].body.content.map((item: any) => [item.type, item.role]), [["text", undefined], ["image_url", "reference_image"], ["video_url", "reference_video"]]);
    await assert.rejects(f.provider.submitVideoTask({ prompt: "x", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: ["imageReference:9", "videoReference:3", "audioReference:3"], referenceList: [videoRef("data:video/mp4;base64,AAAA")] }, model20), /必须是 HTTP/);
    f.setHandler(() => new Response(JSON.stringify({ status: "MYSTERY" }), { status: 200 }));
    await assert.rejects(f.provider.queryVideoTask("unknown"), /未知状态/);
    f.setHandler(() => new Response(JSON.stringify({ message: "Bearer agentsyun-local-key" }), { status: 401 }));
    await assert.rejects(f.provider.submitVideoTask({ prompt: "x", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "text", referenceList: [] }, model20), (error: Error) => !error.message.includes("agentsyun-local-key") && error.message.includes("redacted"));
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 2);
    f.setHandler(() => new Response(JSON.stringify({ message: "timeout" }), { status: 408 }));
    await assert.rejects(f.provider.submitVideoTask({ prompt: "x", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "text", referenceList: [] }, model20), (error: any) => error.message.includes("HTTP 408") && error.submissionOutcome === undefined);
  });
});
