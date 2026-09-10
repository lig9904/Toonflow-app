import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { transform } from "sucrase";
import { VM } from "vm2";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
type Fixture = { provider: Record<string, any>; defaultBaseUrl: string; calls: Call[]; setHandler: (handler: (call: Call) => Response | Promise<Response>) => void; reset: () => void };

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function fixture(): Promise<Fixture> {
  const source = await readFile(path.resolve(process.cwd(), "providers/kzOpenApi.ts"), "utf8");
  const javascript = transform(source, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const provider: Record<string, any> = {};
  const calls: Call[] = [];
  let handler: (call: Call) => Response | Promise<Response> = () => json({});
  const call = async (input: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const rawBody = init.body;
    let body: any = rawBody;
    if (typeof rawBody === "string") body = JSON.parse(rawBody);
    const item = { url: String(input), method: init.method || "GET", headers, body };
    calls.push(item);
    return handler(item);
  };
  new VM({
    timeout: 0,
    eval: false,
    wasm: false,
    sandbox: {
      exports: provider,
      fetch: call,
      logger: () => undefined,
      AbortController,
      setTimeout,
      clearTimeout,
      URL,
      Headers,
      Response,
      pollTask: async (fn: () => Promise<{ completed: boolean; data?: string; error?: string }>) => fn(),
    },
  }).run(javascript);
  const defaultBaseUrl = provider.vendor.inputValues.baseUrl;
  provider.vendor.inputValues.baseUrl = "https://kz.example.test";
  provider.vendor.inputValues.apiKey = "kz-local-test-key";
  return { provider, defaultBaseUrl, calls, setHandler: (next) => { handler = next; }, reset: () => calls.splice(0) };
}

const t2v = (model: any, overrides: Record<string, unknown> = {}) => ({ prompt: "a cat runs through a sunny field", duration: 5, resolution: "720p", aspectRatio: "16:9", audio: true, mode: "text", referenceList: [], ...overrides });
const urlRef = (type: "image" | "video" | "audio", url: string) => ({ type, sourceType: "url", url });

describe("KZ OpenAPI provider contract", () => {
  it("exposes exactly the four documented video models and native capabilities", async () => {
    const f = await fixture();
    assert.equal(f.provider.vendor.id, "kzOpenApi");
    assert.equal(f.provider.vendor.name, "筷子科技·丽帧");
    assert.equal(f.defaultBaseUrl, "https://aiopenapi.kuaizi.cn");
    assert.deepEqual(f.provider.vendor.models.map((m: any) => m.modelName), [
      "doubao-seedance-2-0-260128",
      "doubao-seedance-2-0-fast-260128",
      "doubao-seedance-2-0-mini-260615",
      "doubao-seedance-2-5-260628",
    ]);
    assert.equal(f.provider.vendor.models.some((m: any) => m.type !== "video"), false);
    assert.deepEqual(f.provider.vendor.models[0].durationResolutionMap[0].resolution, ["480p", "720p", "1080p", "4k"]);
    assert.deepEqual(f.provider.vendor.models[1].durationResolutionMap[0].resolution, ["480p", "720p", "1080p"]);
    assert.deepEqual(f.provider.vendor.models[3].durationResolutionMap[0].duration, Array.from({ length: 27 }, (_v, i) => i + 4));
    assert.deepEqual(f.provider.vendor.models[3].durationResolutionMap[0].resolution, ["480p", "720p", "1080p"]);
    assert.equal(f.provider.vendor.models.some((m: any) => m.durationResolutionMap.some((x: any) => x.resolution.includes("2k") || x.resolution.includes("native1080p"))), false);
  });

  it("constructs one T2V POST with the correct v1.2 path and Bearer platform key", async () => {
    const f = await fixture();
    const model = f.provider.vendor.models[1];
    f.setHandler((call) => call.method === "POST" ? json({ id: "kz-cgt-t2v", status: "queued" }) : json({ status: "succeeded", content: { kz_video_url: "https://cdn.example.test/result.mp4" } }));
    assert.deepEqual(await f.provider.submitVideoTask(t2v(model, { duration: 15, resolution: "1080p", aspectRatio: "21:9" }), model), { taskId: "kz-cgt-t2v" });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, "https://kz.example.test/ai-open-platform-api/api/v3/contents/generations/tasks");
    assert.equal(f.calls[0].headers.authorization, "Bearer kz-local-test-key");
    assert.equal(f.calls[0].headers.apikey, undefined);
    assert.deepEqual(f.calls[0].body, {
      model: "doubao-seedance-2-0-fast-260128",
      content: [{ type: "text", text: "a cat runs through a sunny field" }],
      resolution: "1080p", ratio: "21:9", duration: 15, generate_audio: true, watermark: false,
    });
  });

  it("keeps submit and query durable, prioritizes kz_video_url, and rejects false success", async () => {
    const f = await fixture();
    const model = f.provider.vendor.models[0];
    f.setHandler((call) => call.method === "POST" ? json({ id: "kz-cgt-durable" }) : json({ status: "succeeded", content: { kz_video_url: "https://cdn.example.test/persisted.mp4", video_url: "https://cdn.example.test/raw.mp4" } }));
    assert.deepEqual(await f.provider.submitVideoTask(t2v(model), model), { taskId: "kz-cgt-durable" });
    assert.deepEqual(await f.provider.queryVideoTask("kz-cgt-durable"), { status: "succeeded", outputUrl: "https://cdn.example.test/persisted.mp4" });
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
    assert.equal(f.calls[1].url, "https://kz.example.test/ai-open-platform-api/api/v3/contents/generations/tasks/kz-cgt-durable");
    f.reset();
    f.setHandler(() => json({ status: "succeeded", content: {} }));
    await assert.rejects(f.provider.queryVideoTask("kz-cgt-empty"), /未返回有效视频 URL/);
    f.reset();
    f.setHandler(() => json({ status: "mystery" }));
    await assert.rejects(f.provider.queryVideoTask("kz-cgt-unknown"), /未知状态/);
  });

  it("builds URL/asset references in order and sends explicit 2.5 task type", async () => {
    const f = await fixture();
    const model = f.provider.vendor.models[3];
    f.setHandler((call) => call.method === "POST" ? json({ id: "kz-cgt-ref" }) : json({ status: "succeeded", content: { video_url: "https://cdn.example.test/ref.mp4" } }));
    await f.provider.submitVideoTask(t2v(model, {
      prompt: "编辑 reference video",
      duration: -1,
      resolution: "1080p",
      aspectRatio: "adaptive",
      mode: ["imageReference:30", "videoReference:10", "audioReference:10"],
      omniReferenceTaskType: "edit",
      referenceList: [urlRef("image", "https://media.example.test/a.png"), { type: "video", assetId: "1800657071180349888" }, urlRef("audio", "https://media.example.test/a.wav")],
    }), model);
    const body = f.calls[0].body;
    assert.deepEqual(body.content.map((item: any) => [item.type, item.role, item[item.type].url]), [
      ["text", undefined, undefined],
      ["image_url", "reference_image", "https://media.example.test/a.png"],
      ["video_url", "reference_video", "asset://1800657071180349888"],
      ["audio_url", "reference_audio", "https://media.example.test/a.wav"],
    ]);
    assert.equal(body.omni_reference_task_type, "edit");
    assert.equal(body.duration, -1);
  });

  it("rejects undocumented local base64 references before any POST and validates model limits", async () => {
    const f = await fixture();
    const model25 = f.provider.vendor.models[3];
    await assert.rejects(f.provider.submitVideoTask(t2v(model25, { mode: "singleImage", referenceList: [{ type: "image", sourceType: "base64", base64: "data:image/png;base64,AAAA" }] }), model25), /未在已审文档中提供/);
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.provider.submitVideoTask(t2v(model25, { resolution: "4k" }), model25), /不支持 4k/);
    await assert.rejects(f.provider.submitVideoTask(t2v(model25, { duration: 31 }), model25), /4~30/);
    const model20 = f.provider.vendor.models[0];
    await assert.rejects(f.provider.submitVideoTask(t2v(model20, { duration: 16 }), model20), /4~15/);
    await assert.rejects(f.provider.submitVideoTask(t2v(model20, { mode: ["imageReference:9", "videoReference:3", "audioReference:3"], referenceList: [urlRef("audio", "https://media.example.test/a.wav")] }), model20), /音频参考必须同时/);
    assert.equal(f.calls.length, 0);
  });

  it("enforces 2.5 adaptive/edit constraints and maps asset API with its separate ApiKey header", async () => {
    const f = await fixture();
    const model = f.provider.vendor.models[3];
    f.setHandler(() => json({ id: "kz-cgt-adaptive" }));
    await f.provider.submitVideoTask(t2v(model, { mode: "singleImage", aspectRatio: "16:9", referenceList: [urlRef("image", "https://media.example.test/a.png")] }), model);
    assert.equal(f.calls[0].body.ratio, "adaptive");
    f.reset();
    await assert.rejects(f.provider.submitVideoTask(t2v(model, { mode: ["imageReference:30", "videoReference:10", "audioReference:10"], aspectRatio: "adaptive", omniReferenceTaskType: "edit", referenceList: [urlRef("video", "https://media.example.test/a.mp4")] }), model), /duration 必须/);
    f.setHandler(() => json({ ResponseMetadata: { RequestId: "req-1", Action: "CreateAsset", Version: "2024-01-01" }, Result: { Id: "1800657071180349888" } }));
    assert.deepEqual(await f.provider.createAsset({ GroupId: "1800657071180349525", URL: "https://media.example.test/a.mp4", AssetType: "Video" }), { Id: "1800657071180349888" });
    assert.equal(f.calls[0].url, "https://kz.example.test/ai-open-platform-api/api/support/v1/asset?Action=CreateAsset&Version=2024-01-01");
    assert.equal(f.calls[0].headers.apikey, "kz-local-test-key");
    assert.equal(f.calls[0].headers.authorization, undefined);
    assert.equal(f.calls[0].body.GroupId, "1800657071180349525");
    assert.equal(f.calls[0].body.URL, "https://media.example.test/a.mp4");
    f.reset();
    f.setHandler(() => json({ ResponseMetadata: { Error: { Code: "Unauthorized", Message: "invalid ApiKey" } } }));
    await assert.rejects(f.provider.getAsset("1800657071180349888"), /素材 GetAsset 失败/);
  });
});
