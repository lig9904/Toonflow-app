import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import axios from "axios";
import checkUpdate from "../src/routes/setting/about/checkUpdate";
import downloadApp from "../src/routes/setting/about/downloadApp";

async function dispatch(router: any, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req: any = { method: "POST", url: "/", originalUrl: "/", body, headers: {} };
    const response: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      send(payload: unknown) { resolve({ status: this.statusCode, body: payload }); return this; },
      json(payload: unknown) { resolve({ status: this.statusCode, body: payload }); return this; },
      setHeader() { return this; },
    };
    router.handle(req, response, (error?: unknown) => error ? reject(error) : reject(new Error("route did not respond")));
  });
}

describe("managed custom update policy", () => {
  it("does not call fetch for legacy or custom update sources and returns no URL", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error("unexpected external request"); }) as typeof fetch;
    try {
      for (const body of [
        { source: "toonflow" },
        { source: "github", url: "https://example.invalid/custom-manifest.json" },
      ]) {
        const result = await dispatch(checkUpdate, body);
        assert.equal(result.status, 200);
        assert.equal(result.body.data.needUpdate, false);
        assert.equal(result.body.data.managed, true);
        assert.equal(result.body.data.policy, "managed");
        assert.equal(result.body.data.reinstall, false);
        assert.equal(result.body.data.time, 0);
        assert.equal("url" in result.body.data, false);
        assert.equal(result.body.data.repositories.backend, "https://github.com/lig9904/Toonflow-app");
      }
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(calls, 0);
  });

  it("rejects both reinstall and incremental download requests without external or file operations", async (t) => {
    const forbiddenCalls: string[] = [];
    for (const method of ["mkdirSync", "writeFileSync", "cpSync", "rmSync"] as const) {
      t.mock.method(fs, method, () => { forbiddenCalls.push(method); throw new Error("unexpected file mutation"); });
    }
    t.mock.method(axios, "get", () => { forbiddenCalls.push("axios.get"); throw new Error("unexpected download"); });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error("unexpected external request"); }) as typeof fetch;
    try {
      for (const reinstall of [true, false]) {
        const result = await dispatch(downloadApp, { url: "https://example.invalid/update.zip", reinstall, version: "9.9.9" });
        assert.equal(result.status, 409);
        assert.match(result.body.message, /管理员部署/);
      }
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(calls, 0);
    assert.deepEqual(forbiddenCalls, []);
  });
});
