import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { transform } from "sucrase";
import { VM } from "vm2";
import { createPersistentImageTaskProvider } from "../src/lib/persistentImageAdapter";
import { createPersistentVideoTaskProvider } from "../src/lib/persistentVideoAdapter";

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };
async function fixture() {
  const source = await readFile(path.resolve(process.cwd(), "data/vendor/volcengineSd2.ts"), "utf8");
  const javascript = transform(source, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const provider: Record<string, any> = {};
  const calls: Call[] = [], logs: unknown[] = [];
  let handler: (call: Call) => Response | Promise<Response> = () => { throw new Error("fetch handler missing"); };
  const fetchMock = async (input: string, init: RequestInit = {}) => {
    const call = { url: String(input), method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call); return handler(call);
  };
  new VM({ timeout: 0, eval: false, wasm: false, sandbox: { exports: provider, fetch: fetchMock, URL, Response, Headers, Buffer,
    logger: (value: unknown) => logs.push(value), urlToBase64: async (url: string) => `downloaded:${url}`, pollTask: async (fn: any) => fn() } }).run(javascript);
  provider.vendor.inputValues.apiKey = "Bearer sd2-test-key";
  provider.vendor.inputValues.baseUrl = " https://ark.example.test/api/v3/ ";
  return { provider, calls, logs, setHandler(value: typeof handler) { handler = value; } };
}
const imageReference = (value = "data:image/png;base64,AAAA") => ({ type: "image", sourceType: "base64", base64: value });
const videoReference = () => ({ type: "video", sourceType: "url", url: "https://media.example.test/reference.mp4" });
const audioReference = () => ({ type: "audio", sourceType: "base64", base64: "data:audio/wav;base64,AAAA" });

describe("official Volcengine Seedream and Seedance provider", () => {
  it("publishes only current Seedream and Seedance 2.x media with exact capability metadata", async () => {
    const { provider } = await fixture();
    assert.equal(provider.vendor.id, "volcengineSd2");
    assert.equal(provider.vendor.name, "火山引擎sd2.0真人");
    assert.equal(provider.vendor.version, "3.1");
    assert.equal(provider.persistentVideoTaskVersion, 1);
    assert.equal(provider.synchronousImageRequestVersion, 1);
    assert.deepEqual(provider.vendor.models.map((model: any) => model.modelName), [
      "doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-lite-260128", "doubao-seedream-4-5-251128", "doubao-seedream-4-0-250828",
      "doubao-seedance-2-5-260628", "doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128", "doubao-seedance-2-0-mini-260615",
    ]);
    assert.deepEqual(provider.vendor.models[0].resolutions, ["1K", "1.5K", "2K"]);
    assert.deepEqual(provider.vendor.models[1].resolutions, ["2K", "3K", "4K"]);
    assert.deepEqual(provider.vendor.models[4].mode.at(-1), ["imageReference:30", "videoReference:10", "audioReference:10"]);
    assert.deepEqual(provider.vendor.models[4].mode.slice(0, 4), ["text", "singleImage", "endFrameOptional", "startEndRequired"]);
    assert.equal(provider.vendor.models[4].durationResolutionMap[0].duration.at(-1), 30);
    assert.deepEqual(provider.vendor.models[5].durationResolutionMap[0].resolution, ["480p", "720p", "1080p", "4k"]);
    assert.deepEqual(provider.vendor.models[6].durationResolutionMap[0].resolution, ["480p", "720p"]);
    assert(provider.vendor.models.slice(4).every((model: any) => model.referenceTransport === "url" && model.referenceRatio === "adaptive"));
    assert(provider.vendor.inputs.filter((input: any) => input.required).every((input: any) => ["apiKey", "baseUrl"].includes(input.key)));
  });

  it("uses the persistent synchronous image contract and official model-specific sizes", async () => {
    const f = await fixture();
    const pro = f.provider.vendor.models[0], lite = f.provider.vendor.models[1];
    f.setHandler(() => new Response(JSON.stringify({ data: [{ url: "https://cdn.example.test/result.png" }] }), { status: 200 }));
    const persistent = createPersistentImageTaskProvider({ vendorId: f.provider.vendor.id, modelName: pro.modelName, endpoint: f.provider.vendor.inputValues.baseUrl,
      model: pro, enabled: true, synchronousImageRequestVersion: f.provider.synchronousImageRequestVersion, synchronousImageRequest: f.provider.synchronousImageRequest, runtime: f.provider });
    assert.deepEqual(await persistent.submit({ prompt: "portrait", size: "1.5K", aspectRatio: "9:16", referenceList: [imageReference()] }), { outputUrl: "https://cdn.example.test/result.png" });
    assert.equal(f.calls[0].url, "https://ark.example.test/api/v3/images/generations");
    assert.equal(f.calls[0].body.size, "1.5K");
    assert.match(f.calls[0].body.prompt, /9:16/);
    assert.equal("sequential_image_generation" in f.calls[0].body, false);
    await f.provider.synchronousImageRequest({ prompt: "landscape", size: "3K", aspectRatio: "16:9" }, lite);
    assert.equal(f.calls[1].body.size, "3K");
    assert.equal(f.calls[1].body.sequential_image_generation, "disabled");
    await assert.rejects(f.provider.synchronousImageRequest({ prompt: "x", size: "4K", aspectRatio: "1:1" }, pro), (error: any) => error.submissionOutcome === "not_submitted");
    await assert.rejects(f.provider.synchronousImageRequest({ prompt: "x", size: "2K", aspectRatio: "1:1", referenceList: Array.from({ length: 11 }, () => imageReference()) }, pro), /最多支持 10/);
    f.setHandler(() => new Response(JSON.stringify({ error: { code: "AccessDenied", message: "Bearer sd2-test-key" } }), { status: 200 }));
    await assert.rejects(f.provider.synchronousImageRequest({ prompt: "x", size: "2K", aspectRatio: "1:1" }, pro), (error: any) => error.submissionOutcome === "rejected" && /AccessDenied/.test(error.message) && !/sd2-test-key/.test(error.message));
    assert.equal(f.logs.length, 0);
  });

  it("submits and queries one durable 2.5 task with leased HTTP media or authorized asset references", async () => {
    const f = await fixture(), model = f.provider.vendor.models[4];
    f.setHandler((call) => call.method === "POST" ? new Response(JSON.stringify({ id: "task / 1" }), { status: 200 }) : new Response(JSON.stringify({ status: "succeeded", content: { video_url: "https://cdn.example.test/video.mp4" } }), { status: 200 }));
    const persistent = createPersistentVideoTaskProvider({ vendorId: f.provider.vendor.id, modelName: model.modelName, endpoint: f.provider.vendor.inputValues.baseUrl,
      model, enabled: true, persistentVideoTaskVersion: f.provider.persistentVideoTaskVersion, submitVideoTask: f.provider.submitVideoTask, queryVideoTask: f.provider.queryVideoTask, runtime: f.provider });
    const mode = ["imageReference:30", "videoReference:10", "audioReference:10"];
    assert.deepEqual(await persistent.submit({ prompt: "scene", duration: 30, resolution: "1080p", aspectRatio: "16:9", audio: true, mode,
      referenceList: [imageReference("asset://authorized-human"), videoReference(), audioReference()] }), { taskId: "task / 1" });
    assert.equal(f.calls[0].body.omni_reference_task_type, "reference");
    assert.deepEqual(f.calls[0].body.content.slice(1).map((item: any) => item.image_url?.url ?? item.video_url?.url ?? item.audio_url?.url), ["asset://authorized-human", "https://media.example.test/reference.mp4", "data:audio/wav;base64,AAAA"]);
    assert.deepEqual(await persistent.query("task / 1"), { status: "succeeded", outputUrl: "https://cdn.example.test/video.mp4" });
    assert.equal(f.calls[1].url, "https://ark.example.test/api/v3/contents/generations/tasks/task%20%2F%201");
    assert.equal(f.logs.length, 0);
  });

  it("lets first-frame images determine the output ratio while preserving text and reference ratios", async () => {
    const f = await fixture();
    f.setHandler(() => new Response(JSON.stringify({ id: "task-first-frame" }), { status: 200 }));
    for (const model of f.provider.vendor.models.filter((item: any) => item.type === "video")) {
      for (const mode of ["singleImage", "endFrameOptional", "startEndRequired"]) {
        await f.provider.submitVideoTask({ prompt: "scene", duration: 4, resolution: "480p", aspectRatio: "16:9", mode,
          referenceList: mode === "startEndRequired" ? [imageReference(), imageReference()] : [imageReference()] }, model);
        assert.equal("ratio" in f.calls.at(-1)!.body, false, `${model.modelName}:${mode}`);
      }
      await f.provider.submitVideoTask({ prompt: "scene", duration: 4, resolution: "480p", aspectRatio: "9:16", mode: "text", referenceList: [] }, model);
      assert.equal(f.calls.at(-1)!.body.ratio, "9:16");
      await f.provider.submitVideoTask({ prompt: "scene", duration: 4, resolution: "480p", aspectRatio: "9:16", mode: model.mode.at(-1), referenceList: [imageReference()] }, model);
      assert.equal(f.calls.at(-1)!.body.ratio, "9:16");
    }
  });

  it("rejects invalid capabilities before POST and distinguishes upstream rejection from uncertainty", async () => {
    const f = await fixture(), standard = f.provider.vendor.models[5], fast = f.provider.vendor.models[6];
    await assert.rejects(f.provider.submitVideoTask({ prompt: "x", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "startEndRequired", referenceList: [imageReference()] }, standard), (error: any) => error.submissionOutcome === "not_submitted");
    await assert.rejects(f.provider.submitVideoTask({ prompt: "x", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: ["imageReference:9", "videoReference:3", "audioReference:3"], referenceList: [audioReference()] }, standard), /不能仅输入音频/);
    await assert.rejects(f.provider.submitVideoTask({ prompt: "x", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: ["imageReference:9", "videoReference:3", "audioReference:3"], referenceList: [{ type: "video", base64: "data:video/mp4;base64,AAAA" }] }, standard), /不支持 Base64/);
    await assert.rejects(f.provider.submitVideoTask({ prompt: "x", duration: 5, resolution: "4k", aspectRatio: "16:9", mode: "text", referenceList: [] }, fast), (error: any) => error.submissionOutcome === "not_submitted");
    assert.equal(f.calls.length, 0);
    f.setHandler(() => new Response(JSON.stringify({ error: { code: "InvalidParameter", message: "bad sd2-test-key Bearer secret-token" } }), { status: 400 }));
    await assert.rejects(f.provider.submitVideoTask({ prompt: "x", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "text", referenceList: [] }, fast), (error: any) => error.submissionOutcome === "rejected" && /InvalidParameter/.test(error.message) && !/sd2-test-key|secret-token/.test(error.message));
    f.setHandler(() => new Response("{}", { status: 503 }));
    await assert.rejects(f.provider.submitVideoTask({ prompt: "x", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "text", referenceList: [] }, fast), (error: any) => error.submissionOutcome === undefined);
    f.setHandler(() => new Response("{}", { status: 408 }));
    await assert.rejects(f.provider.submitVideoTask({ prompt: "x", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "text", referenceList: [] }, fast), (error: any) => error.submissionOutcome === undefined);
    f.setHandler(() => new Response("{}", { status: 200 }));
    await assert.rejects(f.provider.submitVideoTask({ prompt: "x", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "text", referenceList: [] }, fast), (error: any) => error.submissionOutcome === undefined);
  });
});
