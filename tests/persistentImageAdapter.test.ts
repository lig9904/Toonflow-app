import assert from "node:assert/strict";
import test from "node:test";
import { createPersistentImageTaskProvider, PersistentImageAdapterError } from "../src/lib/persistentImageAdapter";

const model = { modelName: "seedream-test" };
const good = (overrides: Record<string, unknown> = {}) => createPersistentImageTaskProvider({
  vendorId: "zhenzhenRelay", modelName: "seedream-test", endpoint: "https://relay.example/v1/", model, enabled: true,
  persistentImageTaskVersion: 1,
  submitImageTask: async () => ({ taskId: "task-1" }),
  queryImageTask: async () => ({ status: "pending" }),
  ...overrides,
});

test("versioned image plugin exposes durable submit/query without resubmission", async () => {
  let submitted = 0;
  const provider = good({ submitImageTask: async () => { submitted += 1; return { taskId: "task-1" }; } });
  assert.deepEqual(await provider.submit({ prompt: "scene" }), { taskId: "task-1" });
  assert.deepEqual(await provider.query("task-1"), { status: "pending" });
  assert.equal(submitted, 1);
});

test("old or disabled image plugins are rejected", () => {
  assert.throws(() => createPersistentImageTaskProvider({ vendorId: "old-plugin", modelName: "legacy", endpoint: "https://old.example", model, enabled: true }), PersistentImageAdapterError);
  assert.throws(() => good({ enabled: false }), PersistentImageAdapterError);
  assert.throws(() => good({ persistentImageTaskVersion: 2 }), PersistentImageAdapterError);
});

test("bad task IDs, statuses, and image URLs are rejected", async () => {
  await assert.rejects(good({ submitImageTask: async () => ({ taskId: "" }) }).submit({}), PersistentImageAdapterError);
  await assert.rejects(good({ queryImageTask: async () => ({ status: "unknown" }) }).query("task"), PersistentImageAdapterError);
  await assert.rejects(good({ queryImageTask: async () => ({ status: "succeeded", outputUrl: "file:///nas/image.png" }) }).query("task"), PersistentImageAdapterError);
  await assert.rejects(good({ queryImageTask: async () => ({ status: "succeeded", outputUrl: "https://" }) }).query("task"), PersistentImageAdapterError);
  await assert.rejects(good({ queryImageTask: async () => ({ status: "succeeded", outputUrl: "https://user:pass@example.invalid/image.png" }) }).query("task"), PersistentImageAdapterError);
});

test("query receives the task ID object and timeout is bounded", async () => {
  let request: unknown;
  const provider = good({ queryImageTask: async (value: unknown) => { request = value; return { status: "failed", error: "upstream" }; } });
  assert.deepEqual(await provider.query("task-context"), { status: "failed", error: "upstream" });
  assert.deepEqual(request, { taskId: "task-context" });
  await assert.rejects(good({ timeoutMs: 5, queryImageTask: async () => new Promise(() => {}) }).query("task"), PersistentImageAdapterError);
});
