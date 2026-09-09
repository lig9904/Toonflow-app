import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadZhenzhenProvider, type ZhenzhenFixture } from "./helpers/zhenzhenProviderFixture";

const imageRef = (base64 = "data:image/png;base64,iVBORw0KGgo=") => ({ type: "image", sourceType: "base64", base64 });
const videoRef = (base64 = "data:video/mp4;base64,VklERU8=") => ({ type: "video", sourceType: "base64", base64 });
const audioRef = (base64 = "data:audio/wav;base64,QVVESU8=") => ({ type: "audio", sourceType: "base64", base64 });

async function fixtureOrSkip(_t: { skip: (reason?: string) => void }): Promise<ZhenzhenFixture> {
  return loadZhenzhenProvider();
}

function modelOf(fixture: ZhenzhenFixture, type: string): any {
  const model = fixture.provider.vendor.models?.find((item: any) => item.type === type);
  assert.ok(model, `vendor must expose a ${type} model`);
  return model;
}

describe("Zhenzhen provider public contract", () => {
  it("exposes the vendor metadata and all required public functions", async (t) => {
    const fixture = await fixtureOrSkip(t);
    if (!fixture) return;
    assert.equal(fixture.provider.vendor.id, "zhenzhenRelay");
    assert.equal(fixture.provider.persistentVideoTaskVersion, 1);
    for (const name of ["textRequest", "imageRequest", "videoRequest", "submitVideoTask", "queryVideoTask", "ttsRequest"]) {
      assert.equal(typeof fixture.provider[name], "function", `${name} must be exported`);
    }
    assert.ok(fixture.provider.vendor.models?.length);
  });

  it("creates an OpenAI-compatible text client with the configured base URL and raw model id", async (t) => {
    const fixture = await fixtureOrSkip(t);
    if (!fixture) return;
    fixture.provider.vendor.inputValues.baseUrl = "https://api.seedance.nz";
    fixture.provider.vendor.inputValues.apiKey = "zhenzhen-local-key";
    const model = modelOf(fixture, "text");
    const result = await fixture.provider.textRequest(model, false, 0);
    assert.equal(result.kind, "openai-compatible");
    assert.equal(result.config.baseURL, "https://api.seedance.nz/v1");
    assert.equal(result.config.apiKey, "zhenzhen-local-key");
    assert.equal(result.model, model.modelName);
  });

  it("maps async image results from data fields and rejects missing task/result ids", async (t) => {
    const fixture = await fixtureOrSkip(t);
    if (!fixture) return;
    const model = modelOf(fixture, "image");
    fixture.setHandler((call) => {
      if (call.method === "POST") return new Response(JSON.stringify({ id: "image-task" }), { status: 200 });
      return new Response(JSON.stringify({ data: { status: "SUCCESS", result_url: "https://local.invalid/image.png" } }), { status: 200 });
    });
    const image = await fixture.provider.imageRequest(
      { prompt: "a local image", referenceList: [], size: "1K", aspectRatio: "1:1" },
      model,
    );
    assert.equal(image, "https://local.invalid/image.png");
    assert.equal(fixture.calls.length, 2);
    fixture.resetCalls();
    fixture.setHandler(() => new Response(JSON.stringify({ status: 200, data: {} }), { status: 200 }));
    await assert.rejects(fixture.provider.imageRequest({ prompt: "missing", referenceList: [], size: "1K", aspectRatio: "1:1" }, model));
    assert.equal(fixture.calls.length, 1);

    fixture.resetCalls();
    fixture.setHandler((call) => {
      if (call.method === "POST") return new Response(JSON.stringify({ id: "ratio-task" }), { status: 200 });
      return new Response(JSON.stringify({ data: { status: "SUCCESS", result_url: "not-a-url" } }), { status: 200 });
    });
    await assert.rejects(fixture.provider.imageRequest({ prompt: "ratio image", referenceList: [], size: "1K", aspectRatio: "16:9" }, model), /URL/);
    const ratioBody = fixture.calls.find((call) => call.method === "POST")?.body as any;
    assert.deepEqual([ratioBody.metadata.width, ratioBody.metadata.height], [1280, 720]);

    fixture.resetCalls();
    fixture.setHandler((call) => {
      if (call.method === "POST") return new Response(JSON.stringify({ id: "unknown-task" }), { status: 200 });
      return new Response(JSON.stringify({ data: { status: "MYSTERY" } }), { status: 200 });
    });
    await assert.rejects(fixture.provider.imageRequest({ prompt: "unknown", referenceList: [], size: "1K", aspectRatio: "1:1" }, model), /未知/);
  });

  it("validates all image references before starting any upload", async (t) => {
    const fixture = await fixtureOrSkip(t);
    const model = fixture.provider.vendor.models.find((item: any) => /-i2i$/.test(item.modelName));
    assert.ok(model);
    await assert.rejects(
      fixture.provider.imageRequest(
        { prompt: "invalid ref", referenceList: [imageRef(), { ...imageRef(), base64: "data:text/plain;base64,INVALID" }], size: "1K", aspectRatio: "1:1" },
        model,
      ),
    );
    assert.equal(fixture.calls.length, 0);
  });

  it("maps text-to-video duration as a string and returns the completed URL", async (t) => {
    const fixture = await fixtureOrSkip(t);
    if (!fixture) return;
    const model = fixture.provider.vendor.models.find((item: any) => item.modelName.endsWith("-t2v"));
    assert.ok(model);
    fixture.setHandler((call) => {
      if (call.method === "POST") return new Response(JSON.stringify({ id: "video-task" }), { status: 200 });
      return new Response(JSON.stringify({ status: "completed", metadata: { url: "https://local.invalid/video.mp4" } }), { status: 200 });
    });
    const result = await fixture.provider.videoRequest(
      { prompt: "local t2v", duration: 8, resolution: "720p", aspectRatio: "16:9", audio: true, mode: "text", referenceList: [] },
      model,
    );
    assert.equal(result, "https://local.invalid/video.mp4");
    const create = fixture.calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/videos"));
    assert.ok(create);
    assert.equal((create.body as any).seconds, "8");
    assert.equal((create.body as any).metadata.ratio, "16:9");
  });

  it("keeps submit and query as separate public task contracts", async (t) => {
    const fixture = await fixtureOrSkip(t);
    const model = fixture.provider.vendor.models.find((item: any) => item.modelName.endsWith("-t2v"));
    assert.ok(model);
    fixture.setHandler((call) => {
      if (call.method === "POST") return new Response(JSON.stringify({ id: "submit-task" }), { status: 200 });
      return new Response(JSON.stringify({ status: "completed", metadata: { url: "https://local.invalid/query.mp4" } }), { status: 200 });
    });
    const submitted = await fixture.provider.submitVideoTask(
      { prompt: "submit", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "text", referenceList: [] },
      model,
    );
    assert.deepEqual(submitted, { taskId: "submit-task" });
    const queried = await fixture.provider.queryVideoTask("submit-task");
    assert.deepEqual(queried, { status: "succeeded", outputUrl: "https://local.invalid/query.mp4" });
  });

  it("does not echo the configured API key in upstream errors", async (t) => {
    const fixture = await fixtureOrSkip(t);
    const model = fixture.provider.vendor.models.find((item: any) => item.modelName.endsWith("-t2v"));
    assert.ok(model);
    const secret = fixture.provider.vendor.inputValues.apiKey;
    fixture.setHandler(() => new Response(JSON.stringify({ message: `Bearer ${secret}` }), { status: 500 }));
    await assert.rejects(
      fixture.provider.videoRequest({ prompt: "secret error", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "text", referenceList: [] }, model),
      (error: Error) => !error.message.includes(secret) && error.message.includes("redacted"),
    );
  });

  it("maps i2v first/end frames and multi image/video/audio references with Chinese labels", async (t) => {
    const fixture = await fixtureOrSkip(t);
    if (!fixture) return;
    const model = fixture.provider.vendor.models.find((item: any) => item.modelName.endsWith("-i2v"));
    assert.ok(model);
    fixture.setHandler((call) => {
      if (call.url.endsWith("/v1/files/upload")) return new Response(JSON.stringify({ url: `https://local.invalid/${fixture.calls.length}.bin` }), { status: 200 });
      if (call.method === "POST") return new Response(JSON.stringify({ id: `task-${fixture.calls.length}` }), { status: 200 });
      return new Response(JSON.stringify({ status: "completed", metadata: { url: "https://local.invalid/video.mp4" } }), { status: 200 });
    });
    await fixture.provider.videoRequest(
      { prompt: "frames", duration: 5, resolution: "720p", aspectRatio: "9:16", mode: "startEndRequired", referenceList: [imageRef(), imageRef("data:image/png;base64,RU5E")] },
      model,
    );
    const frameCreate = fixture.calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/videos"));
    assert.deepEqual((frameCreate?.body as any).images, ["https://local.invalid/1.bin", "https://local.invalid/2.bin"]);

    fixture.resetCalls();
    await fixture.provider.videoRequest(
      { prompt: "end frame optional", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "endFrameOptional", referenceList: [imageRef()] },
      model,
    );
    const optionalCreate = fixture.calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/videos"));
    assert.deepEqual((optionalCreate?.body as any).images, ["https://local.invalid/1.bin"]);

    fixture.resetCalls();
    const multiModel = fixture.provider.vendor.models.find((item: any) => item.modelName.endsWith("-multi"));
    assert.ok(multiModel);
    await fixture.provider.videoRequest(
      {
        prompt: "融合 @图片1 与 @视频1 和 @音频1",
        duration: 5,
        resolution: "720p",
        aspectRatio: "16:9",
        mode: [["imageReference:9", "videoReference:3", "audioReference:3"]],
        referenceList: [imageRef(), videoRef(), audioRef()],
      },
      multiModel,
    );
    const multiCreate = fixture.calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/videos"));
    assert.deepEqual(
      (multiCreate?.body as any).metadata.content.map((item: any) => item.type),
      ["image_url", "video_url", "audio_url"],
    );
    assert.match((multiCreate?.body as any).prompt, /@Image 1/);
    assert.match((multiCreate?.body as any).prompt, /@Video 1/);
    assert.match((multiCreate?.body as any).prompt, /@Audio 1/);

    fixture.resetCalls();
    await fixture.provider.videoRequest(
      {
        prompt: "@图片1 与 @视频1 和 @音频1",
        duration: 5,
        resolution: "720p",
        aspectRatio: "16:9",
        mode: ["imageReference:9", "videoReference:3", "audioReference:3"],
        referenceList: [imageRef(), videoRef(), audioRef()],
      },
      multiModel,
    );
    const flatCreate = fixture.calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/videos"));
    assert.match((flatCreate?.body as any).prompt, /@Image 1/);
  });

  it("uploads binary multipart bytes with MIME intact and never submits after upload failure", async (t) => {
    const fixture = await fixtureOrSkip(t);
    if (!fixture) return;
    const model = fixture.provider.vendor.models.find((item: any) => item.modelName.endsWith("-i2v"));
    assert.ok(model);
    fixture.setHandler((call) => {
      if (call.url.endsWith("/v1/files/upload")) return new Response(JSON.stringify({ url: "https://local.invalid/uploaded.png" }), { status: 200 });
      if (call.method === "POST") return new Response(JSON.stringify({ id: "video-task" }), { status: 200 });
      return new Response(JSON.stringify({ status: "completed", metadata: { url: "https://local.invalid/result.mp4" } }), { status: 200 });
    });
    await fixture.provider.videoRequest(
      { prompt: "upload", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "singleImage", referenceList: [imageRef("data:image/png;base64,iVBORw0KGgo=")] },
      model,
    );
    const upload = fixture.calls.find((call) => call.kind === "axios" && call.url.endsWith("/v1/files/upload"));
    assert.equal(typeof (upload?.body as { getBuffer?: unknown })?.getBuffer, "function");
    const multipart = (upload?.body as FormData & { getBuffer: () => Buffer }).getBuffer();
    assert.ok(multipart.includes(Buffer.from("image/png")));
    assert.ok(multipart.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])));

    const failedFixture = await loadZhenzhenProvider();
    const failedModel = failedFixture.provider.vendor.models.find((item: any) => item.modelName.endsWith("-i2v"));
    assert.ok(failedModel);
    failedFixture.setHandler((call) => (call.url.endsWith("/v1/files/upload") ? new Response("upload failed", { status: 503 }) : new Response("unexpected", { status: 500 })));
    await assert.rejects(
      failedFixture.provider.videoRequest(
        { prompt: "failed upload", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "singleImage", referenceList: [imageRef("data:image/png;base64,RkFJTA==")] },
        failedModel,
      ),
    );
    assert.equal(failedFixture.calls.some((call) => call.url.endsWith("/v1/videos")), false);

    const stalledFixture = await loadZhenzhenProvider({ fastTimeout: true });
    const stalledModel = stalledFixture.provider.vendor.models.find((item: any) => item.modelName.endsWith("-i2v"));
    assert.ok(stalledModel);
    stalledFixture.setHandler((call) => (call.url.endsWith("/v1/files/upload") ? new Promise(() => undefined) : new Response("unexpected", { status: 500 })));
    await assert.rejects(
      stalledFixture.provider.videoRequest(
        { prompt: "upload timeout", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "singleImage", referenceList: [imageRef("data:image/png;base64,VEIMEQ==")] },
        stalledModel,
      ),
      /timeout|超时/i,
    );
    assert.equal(stalledFixture.calls.some((call) => call.url.endsWith("/v1/videos")), false);
  });

  it("rejects invalid modes/reference limits/MIME before the first network call", async (t) => {
    const fixture = await fixtureOrSkip(t);
    if (!fixture) return;
    const model = fixture.provider.vendor.models.find((item: any) => item.modelName.endsWith("-t2v"));
    assert.ok(model);
    const invalid = { prompt: "invalid", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: "unsupported", referenceList: [] };
    await assert.rejects(fixture.provider.videoRequest(invalid, model));
    assert.equal(fixture.calls.length, 0);
    fixture.resetCalls();
    const multiModel = fixture.provider.vendor.models.find((item: any) => item.modelName.endsWith("-multi"));
    assert.ok(multiModel);
    await assert.rejects(fixture.provider.videoRequest({ ...invalid, mode: "text", referenceList: [imageRef()] }, multiModel));
    assert.equal(fixture.calls.length, 0);
    fixture.resetCalls();
    await assert.rejects(
      fixture.provider.videoRequest(
        { ...invalid, mode: [["imageReference:9"]], referenceList: Array.from({ length: 10 }, () => imageRef()) },
        model,
      ),
    );
    assert.equal(fixture.calls.length, 0);
    fixture.resetCalls();
    await assert.rejects(fixture.provider.videoRequest({ ...invalid, mode: "singleImage", referenceList: [{ type: "image", sourceType: "base64", base64: "data:text/plain;base64,INVALID" }] }, model));
    assert.equal(fixture.calls.length, 0);
  });

  it("validates every reference before uploading any of them", async (t) => {
    const fixture = await fixtureOrSkip(t);
    const model = fixture.provider.vendor.models.find((item: any) => item.modelName.endsWith("-multi"));
    assert.ok(model);
    await assert.rejects(
      fixture.provider.videoRequest(
        { prompt: "bad second ref", duration: 5, resolution: "720p", aspectRatio: "16:9", mode: [["imageReference:9", "audioReference:3"]], referenceList: [imageRef(), { ...audioRef(), base64: "data:text/plain;base64,INVALID" }] },
        model,
      ),
    );
    assert.equal(fixture.calls.length, 0);
  });

  it("rejects unsupported TTS before any network call", async (t) => {
    const fixture = await fixtureOrSkip(t);
    await assert.rejects(fixture.provider.ttsRequest({ text: "hello" }, {}), /不支持|unsupported/i);
    assert.equal(fixture.calls.length, 0);
  });
});
