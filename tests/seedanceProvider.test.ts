import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, describe, it } from "node:test";
import path from "node:path";
import { transform } from "sucrase";
import { VM } from "vm2";
import { buildSeedance2AssetReferenceContext } from "../src/lib/videoPromptReferences";

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: any };

const providerPath = path.resolve(process.cwd(), "data/vendor/volcengine.ts");
const baseUrl = "http://127.0.0.1:18765/api/v3";
const apiKey = "seedance-local-test-key";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Seedance prompt media references", () => {
  it("numbers image, video, and audio references independently", () => {
    const context = buildSeedance2AssetReferenceContext([
      { id: 1, type: "role", name: "hero", filePath: "/hero.png", mediaType: "image" },
      { id: 2, type: "clip", name: "movement", filePath: "/movement.mp4", mediaType: "video" },
      { id: 3, type: "audio", name: "voice", filePath: "/voice.wav", mediaType: "audio" },
      { id: 4, type: "scene", name: "room", filePath: "/room.jpg", mediaType: "image" },
    ]);
    const mappings = JSON.parse(context.split("\n")[1].split(":").slice(1).join(":"));
    assert.deepEqual(
      mappings.map((item: any) => [item.mediaType, item.referenceLabel]),
      [
        ["image", "@图片1"],
        ["video", "@视频1"],
        ["audio", "@音频1"],
        ["image", "@图片2"],
      ],
    );
  });
});

describe("Seedance provider local contract", () => {
  let provider: any;
  let calls: FetchCall[];
  let fetchHandler: (call: FetchCall) => Response | Promise<Response>;

  before(async () => {
    const source = await readFile(providerPath, "utf8");
    const javascript = transform(source, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
    const exports = {};
    const vm = new VM({
      timeout: 0,
      eval: false,
      wasm: false,
      sandbox: {
        exports,
        logger: () => undefined,
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const headers = Object.fromEntries(new Headers(init?.headers).entries());
          const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
          return fetchHandler({ url: String(input), method: init?.method ?? "GET", headers, body });
        },
        pollTask: async (fn: () => Promise<{ completed: boolean; data?: string; error?: string }>) => fn(),
      },
    });
    vm.run(javascript);
    provider = exports;
    provider.vendor.inputValues.baseUrl = baseUrl;
    provider.vendor.inputValues.apiKey = `Bearer ${apiKey}`;
    calls = [];
    fetchHandler = () => {
      throw new Error("mock fetch handler was not set");
    };
  });

  function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
    calls = [];
    fetchHandler = (call) => {
      calls.push(call);
      return handler(call);
    };
  }

  function seedanceModel() {
    const model = provider.vendor.models.find((item: any) => item.modelName === "doubao-seedance-2-0-260128");
    assert.ok(model, "Seedance 2.0 model must remain in the provider catalog");
    return model;
  }

  it("keeps only image/video/audio reference kinds in the Seedance 2 model config", () => {
    const model = seedanceModel();
    assert.deepEqual(model.mode, ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]]);
    const configuredKinds = (model.mode[2] as string[]).map((item) => item.split(":")[0]);
    assert.deepEqual(configuredKinds.sort(), ["audioReference", "imageReference", "videoReference"]);
  });

  it("uses the expected create/query paths, Bearer header, and typed media references", async () => {
    mockFetch((call) => {
      if (call.method === "POST") return response({ id: "task-local-1" });
      assert.equal(call.method, "GET");
      return response({ status: "succeeded", content: { video_url: "https://local.invalid/result.mp4" } });
    });

    const result = await provider.videoRequest(
      {
        prompt: "local contract test",
        duration: 5,
        resolution: "720p",
        aspectRatio: "16:9",
        audio: true,
        mode: ["text", ["imageReference:9", "videoReference:3", "audioReference:3"]],
        referenceList: [
          { type: "image", sourceType: "base64", base64: "data:image/png;base64,IMAGE" },
          { type: "video", sourceType: "base64", base64: "data:video/mp4;base64,VIDEO" },
          { type: "audio", sourceType: "base64", base64: "data:audio/wav;base64,AUDIO" },
        ],
      },
      seedanceModel(),
    );

    assert.equal(result, "https://local.invalid/result.mp4");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, `${baseUrl}/contents/generations/tasks`);
    assert.equal(calls[0].headers.authorization, `Bearer ${apiKey}`);
    assert.equal(calls[0].body.model, "doubao-seedance-2-0-260128");
    assert.deepEqual(
      calls[0].body.content.map((item: any) => item.type),
      ["text", "image_url", "video_url", "audio_url"],
    );
    assert.equal(calls[0].body.content[1].image_url.url, "data:image/png;base64,IMAGE");
    assert.equal(calls[0].body.content[2].video_url.url, "data:video/mp4;base64,VIDEO");
    assert.equal(calls[0].body.content[3].audio_url.url, "data:audio/wav;base64,AUDIO");
    assert.equal(calls[1].url, `${baseUrl}/contents/generations/tasks/task-local-1`);
    assert.equal(calls[1].headers.authorization, `Bearer ${apiKey}`);
  });

  it("surfaces task creation failures without polling", async () => {
    mockFetch(() => response({ error: { message: "local create failure" } }, 503));
    await assert.rejects(
      provider.videoRequest(
        {
          prompt: "local failure",
          duration: 5,
          resolution: "720p",
          aspectRatio: "16:9",
          mode: ["text"],
          referenceList: [],
        },
        seedanceModel(),
      ),
      /视频生成任务创建失败/,
    );
    assert.equal(calls.length, 1);
  });

  it("surfaces failed task results", async () => {
    mockFetch((call) => (call.method === "POST" ? response({ id: "task-local-failed" }) : response({ status: "failed", error: { message: "local task failure" } })));
    await assert.rejects(
      provider.videoRequest(
        {
          prompt: "local task failure",
          duration: 5,
          resolution: "720p",
          aspectRatio: "16:9",
          mode: ["text"],
          referenceList: [],
        },
        seedanceModel(),
      ),
      /local task failure/,
    );
    assert.equal(calls.length, 2);
  });
});
