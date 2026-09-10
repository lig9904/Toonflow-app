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
  it("uses adaptive reference framing for 2.5 I2V while preserving resolution and audio", async () => {
    const f = await loadZhenzhenProvider();
    const model = f.provider.vendor.models.find((m: any) => m.modelName === "seedance-2.5-standard-i2v");
    f.setHandler((call) => new Response(JSON.stringify(call.url.endsWith("/v1/files/upload") ? { url: "https://example.test/start.png" } : { id: "framed-task" }), { status: 200 }));
    await f.provider.submitVideoTask({ prompt: "shot", duration: 4, resolution: "1080p", aspectRatio: "9:16", audio: true, mode: "endFrameOptional", referenceList: [imageRef()] }, model);
    assert.equal(model.referenceRatio, "adaptive");
    const request = f.calls.find((c) => c.url.endsWith("/v1/videos"))!;
    assert.deepEqual((request.body as any).metadata, { resolution: "1080p", ratio: "adaptive", generate_audio: true });
  });

  it("retries a throttled upload with a fresh multipart stream, then submits generation once", async () => {
    const f = await loadZhenzhenProvider(); let uploads = 0;
    const model = f.provider.vendor.models.find((m: any) => m.modelName === "seedance-2.5-standard-i2v");
    f.setHandler((call) => {
      if (call.url.endsWith("/v1/files/upload")) return ++uploads === 1
        ? new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "retry-after": "0" } })
        : new Response(JSON.stringify({ url: "https://example.test/retried.png" }), { status: 200 });
      return new Response(JSON.stringify({ id: "one-generation" }), { status: 200 });
    });
    const value = await f.provider.submitVideoTask({ prompt: "shot", duration: 4, resolution: "1080p", aspectRatio: "9:16", mode: "endFrameOptional", referenceList: [imageRef()] }, model);
    assert.equal(value.taskId, "one-generation");
    assert.equal(uploads, 2); assert.notEqual(f.calls[0].body, f.calls[1].body);
    assert.equal(f.calls.filter((c) => c.url.endsWith("/v1/videos")).length, 1);
  });

  it("marks a long upload throttle as not submitted and an HTTP request rejection as rejected", async () => {
    const f = await loadZhenzhenProvider();
    const model = f.provider.vendor.models.find((m: any) => m.modelName === "seedance-2.5-standard-i2v");
    const config = { prompt: "shot", duration: 4, resolution: "1080p", aspectRatio: "9:16", mode: "endFrameOptional", referenceList: [imageRef()] };
    f.setHandler(() => new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "retry-after": "120" } }));
    await assert.rejects(f.provider.submitVideoTask(config, model), (e: any) => e.submissionOutcome === "not_submitted");
    assert.equal(f.calls.some((c) => c.url.endsWith("/v1/videos")), false);
    f.resetCalls();
    f.setHandler((call) => call.url.endsWith("/v1/files/upload")
      ? new Response(JSON.stringify({ url: "https://example.test/uploaded.png" }), { status: 200 })
      : new Response(JSON.stringify({ error: { message: "price preview invalid_parameter" } }), { status: 400 }));
    await assert.rejects(f.provider.submitVideoTask(config, model), (e: any) => e.submissionOutcome === "rejected");
    assert.equal(f.calls.filter((c) => c.url.endsWith("/v1/videos")).length, 1);
    f.resetCalls();
    f.setHandler(() => { throw new Error("connection lost after send"); });
    await assert.rejects(f.provider.submitVideoTask(config, model), (e: any) => e.submissionOutcome == null);
  });
  it("exposes the vendor metadata and all required public functions", async (t) => {
    const fixture = await fixtureOrSkip(t);
    if (!fixture) return;
    assert.equal(fixture.provider.vendor.id, "zhenzhenRelay");
    assert.equal(fixture.provider.persistentVideoTaskVersion, 1);
    assert.equal(fixture.provider.persistentImageTaskVersion, 1);
    assert.equal(fixture.provider.vendor.models.filter((item: any) => item.type === "text").length, 8);
    assert.equal(fixture.provider.vendor.models.filter((item: any) => item.type === "image").length, 4);
    assert.equal(fixture.provider.vendor.models.filter((item: any) => item.type === "video").length, 24);
    for (const name of ["textRequest", "imageRequest", "submitImageTask", "queryImageTask", "videoRequest", "submitVideoTask", "queryVideoTask", "ttsRequest"]) {
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

  it("keeps image submission and query separate, with one create and exact status URL", async (t) => {
    const fixture = await fixtureOrSkip(t);
    if (!fixture) return;
    const model = modelOf(fixture, "image");
    let creates = 0;
    fixture.setHandler((call) => {
      if (call.method === "POST") { creates += 1; return new Response(JSON.stringify({ task_id: "image-submit" }), { status: 200 }); }
      return new Response(JSON.stringify({ data: { status: "SUCCESS", result_url: "https://local.invalid/image-result.png" } }), { status: 200 });
    });
    assert.deepEqual(await fixture.provider.submitImageTask({ prompt: "submit image", referenceList: [], size: "1K", aspectRatio: "1:1" }, model), { taskId: "image-submit" });
    assert.deepEqual(await fixture.provider.queryImageTask({ taskId: "image-submit" }), { status: "succeeded", outputUrl: "https://local.invalid/image-result.png" });
    assert.equal(creates, 1);
    assert.equal(fixture.calls.filter((call) => call.method === "GET")[0].url, "https://api.seedance.nz/v1/image/generations/image-submit");

    fixture.resetCalls();
    fixture.setHandler((call) => call.method === "POST" ? new Response(JSON.stringify({}), { status: 200 }) : new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await assert.rejects(fixture.provider.submitImageTask({ prompt: "missing id", referenceList: [], size: "1K", aspectRatio: "1:1" }, model), /任务 ID/);
    assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
    fixture.resetCalls();
    await assert.rejects(fixture.provider.queryImageTask({ taskId: "missing" }), /未知|URL|结果/);
    assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 0);
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

  it("exposes only the six documented Seedance 2.5 Standard models and their exact capabilities", async (t) => {
    const fixture = await fixtureOrSkip(t);
    const models = fixture.provider.vendor.models.filter((item: any) => item.type === "video" && item.modelName.startsWith("seedance-2.5-"));
    assert.deepEqual(models.map((item: any) => item.modelName), [
      "seedance-2.5-standard-t2v",
      "seedance-2.5-standard-i2v",
      "seedance-2.5-standard-multi",
      "seedance-2.5-global-standard-t2v",
      "seedance-2.5-global-standard-i2v",
      "seedance-2.5-global-standard-multi",
    ]);
    assert.equal(models.some((item: any) => /-(fast|mini)-/.test(item.modelName)), false);
    for (const model of models) {
      assert.deepEqual(model.durationResolutionMap[0].duration, Array.from({ length: 27 }, (_value, index) => index + 4));
      assert.deepEqual(model.durationResolutionMap[0].resolution, ["480p", "720p", "1080p", "2k", "4k", "native1080p"]);
      assert.equal(model.audio, "optional");
    }
    assert.deepEqual(models.find((item: any) => item.modelName === "seedance-2.5-standard-t2v")?.mode, ["text"]);
    assert.deepEqual(models.find((item: any) => item.modelName === "seedance-2.5-standard-i2v")?.mode, ["endFrameOptional"]);
    assert.deepEqual(models.find((item: any) => item.modelName === "seedance-2.5-standard-multi")?.mode, [["imageReference:30", "videoReference:10", "audioReference:10"]]);
  });

  it("submits Seedance 2.5 through the shared v1 video task protocol with 30-second and native resolution support", async (t) => {
    const fixture = await fixtureOrSkip(t);
    const model = fixture.provider.vendor.models.find((item: any) => item.modelName === "seedance-2.5-global-standard-t2v");
    assert.ok(model);
    fixture.setHandler((call) => call.method === "POST"
      ? new Response(JSON.stringify({ id: "seedance25-task", status: "queued" }), { status: 200 })
      : new Response(JSON.stringify({ status: "completed", metadata: { url: "https://local.invalid/seedance25.mp4" } }), { status: 200 }));
    assert.deepEqual(await fixture.provider.submitVideoTask(
      { prompt: "Seedance 2.5 contract", duration: 30, resolution: "native1080p", aspectRatio: "21:9", audio: false, mode: "text", referenceList: [] },
      model,
    ), { taskId: "seedance25-task" });
    const create = fixture.calls[0];
    assert.equal(create.url, "https://api.seedance.nz/v1/videos");
    assert.equal((create.body as any).model, "seedance-2.5-global-standard-t2v");
    assert.equal((create.body as any).seconds, "30");
    assert.deepEqual((create.body as any).metadata, { resolution: "native1080p", ratio: "21:9", generate_audio: false });
    assert.deepEqual(await fixture.provider.queryVideoTask("seedance25-task"), { status: "succeeded", outputUrl: "https://local.invalid/seedance25.mp4" });
    assert.equal(fixture.calls[1].url, "https://api.seedance.nz/v1/videos/seedance25-task");
  });

  it("keeps Seedance 2.0 limits while applying the larger 2.5 multi-reference boundary in input order", async (t) => {
    const fixture = await fixtureOrSkip(t);
    const oldT2v = fixture.provider.vendor.models.find((item: any) => item.modelName === "seedance-2.0-standard-t2v");
    const model = fixture.provider.vendor.models.find((item: any) => item.modelName === "seedance-2.5-standard-multi");
    assert.ok(oldT2v && model);
    const base = { prompt: "boundary", resolution: "720p", aspectRatio: "16:9", audio: true, mode: "text", referenceList: [] };
    await assert.rejects(fixture.provider.submitVideoTask({ ...base, duration: 16 }, oldT2v), /2\.0.*15/);
    await assert.rejects(fixture.provider.submitVideoTask({ ...base, duration: 5, resolution: "2k" }, oldT2v), /2\.0.*分辨率/);
    await assert.rejects(fixture.provider.submitVideoTask({ ...base, duration: 31 }, { ...model, modelName: "seedance-2.5-standard-t2v" }), /2\.5.*30/);
    await assert.rejects(fixture.provider.submitVideoTask({ ...base, duration: 5 }, { ...model, modelName: "seedance-2.5-fast-t2v" }), /未适配/);
    assert.equal(fixture.calls.length, 0);

    fixture.setHandler((call) => call.url.endsWith("/v1/files/upload")
      ? new Response(JSON.stringify({ url: `https://local.invalid/reference-${fixture.calls.length}` }), { status: 200 })
      : new Response(JSON.stringify({ id: "multi-25" }), { status: 200 }));
    const refs = [videoRef(), imageRef(), audioRef(), imageRef("data:image/png;base64,RUZU")];
    await fixture.provider.submitVideoTask({
      prompt: "@视频1 @图片1 @音频1 @图片2",
      duration: 30,
      resolution: "4k",
      aspectRatio: "adaptive",
      audio: true,
      mode: model.mode,
      referenceList: refs,
    }, model);
    const create = fixture.calls.find((call) => call.url.endsWith("/v1/videos"));
    assert.deepEqual((create?.body as any).metadata.content.map((item: any) => item.type), ["video_url", "image_url", "audio_url", "image_url"]);
    assert.equal((create?.body as any).prompt, "@Video 1 @Image 1 @Audio 1 @Image 2");

    fixture.resetCalls();
    const exactMaximum = [
      ...Array.from({ length: 30 }, () => imageRef()),
      ...Array.from({ length: 10 }, () => videoRef()),
      ...Array.from({ length: 10 }, () => audioRef()),
    ];
    await fixture.provider.submitVideoTask({
      prompt: "exact documented maximum",
      duration: 4,
      resolution: "480p",
      aspectRatio: "16:9",
      mode: model.mode,
      referenceList: exactMaximum,
    }, model);
    const maximumCreate = fixture.calls.find((call) => call.url.endsWith("/v1/videos"));
    assert.equal((maximumCreate?.body as any).metadata.content.length, 50);
    assert.deepEqual(
      (maximumCreate?.body as any).metadata.content.reduce((counts: Record<string, number>, item: any) => ({ ...counts, [item.type]: (counts[item.type] || 0) + 1 }), {}),
      { image_url: 30, video_url: 10, audio_url: 10 },
    );

    const tooMany = Array.from({ length: 31 }, (_value, index) => imageRef(`data:image/png;base64,${Buffer.from(`image-${index}`).toString("base64")}`));
    fixture.resetCalls();
    await assert.rejects(fixture.provider.submitVideoTask({
      prompt: "too many references",
      duration: 4,
      resolution: "480p",
      aspectRatio: "16:9",
      mode: model.mode,
      referenceList: tooMany,
    }, model), /数量超限|模式数量/);
    assert.equal(fixture.calls.length, 0);
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
