import assert from "node:assert/strict";
import test from "node:test";
import { createPersistentVideoTaskProvider, PersistentVideoAdapterError } from "../src/lib/persistentVideoAdapter";

const model = { modelName: "seedance-test" };
const good = (overrides: Record<string, unknown> = {}) => createPersistentVideoTaskProvider({
  vendorId: "zhenzhenRelay", modelName: "seedance-test", endpoint: "https://relay.example/v1/", model, enabled: true,
  persistentVideoTaskVersion: 1,
  submitVideoTask: async () => ({ taskId: "task-1" }),
  queryVideoTask: async () => ({ status: "pending" }),
  ...overrides,
});

test("versioned custom TypeScript plugin is a persistent task provider", async () => {
  const provider = good();
  assert.deepEqual(await provider.submit({ prompt: "scene" }), { taskId: "task-1" });
  assert.deepEqual(await provider.query("task-1"), { status: "pending" });
});

test("old videoRequest-only plugin is rejected", () => {
  assert.throws(() => createPersistentVideoTaskProvider({ vendorId: "old-plugin", modelName: "legacy", endpoint: "https://old.example", model, enabled: true }), PersistentVideoAdapterError);
});

test("disabled plugin is rejected", () => {
  assert.throws(() => good({ enabled: false }), PersistentVideoAdapterError);
});

test("bad submit and query results are rejected instead of becoming recoverable state", async () => {
  await assert.rejects(good({ submitVideoTask: async () => ({ taskId: "" }) }).submit({}), PersistentVideoAdapterError);
  await assert.rejects(good({ queryVideoTask: async () => ({ status: "unknown" }) }).query("task"), PersistentVideoAdapterError);
  await assert.rejects(good({ queryVideoTask: async () => ({ status: "succeeded", outputUrl: "file:///nas/video.mp4" }) }).query("task"), PersistentVideoAdapterError);
  await assert.rejects(good({ queryVideoTask: async () => ({ status: "succeeded", outputUrl: "https://" }) }).query("task"), PersistentVideoAdapterError);
  await assert.rejects(good({ queryVideoTask: async () => ({ status: "succeeded", outputUrl: "https://user:pass@example.invalid/video.mp4" }) }).query("task"), PersistentVideoAdapterError);
});

test("runtime method context is preserved and synchronous throws settle normally", async () => {
  const runtime = { id: "task-context" };
  const provider = good({ runtime, submitVideoTask: function(this: typeof runtime) { return { taskId: this.id }; } });
  assert.deepEqual(await provider.submit({}), { taskId: "task-context" });
  await assert.rejects(good({ submitVideoTask: () => { throw new Error("sync failure"); }, timeoutMs: 5 }).submit({}), /sync failure/);
});

test("legacy Volcengine adapter remains supported and endpoint fingerprint is stable", () => {
  const input = { vendorId: "volcengine", modelName: "seedance", endpoint: "https://ark.example/v3/", model, enabled: true,
    submitVideoTask: async () => ({ taskId: "task" }), queryVideoTask: async () => ({ status: "pending" }) };
  const first = createPersistentVideoTaskProvider(input);
  const second = createPersistentVideoTaskProvider({ ...input, endpoint: "https://ark.example/v3" });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint, createPersistentVideoTaskProvider({ ...input, referenceTransport: "base64" }).fingerprint);
  assert.notEqual(first.fingerprint, createPersistentVideoTaskProvider({ ...input, referenceTransport: "url" }).fingerprint);
});

test("adapter timeout rejects instead of leaving a durable worker slot occupied", async () => {
  const provider = good({ timeoutMs: 5, queryVideoTask: async () => new Promise(() => {}) });
  await assert.rejects(provider.query("task"), PersistentVideoAdapterError);
});

test("adapter preserves an explicit provider submission outcome while leaving timeout unknown", async () => {
  const rejected = good({ submitVideoTask: async () => { throw Object.assign(new Error("HTTP 400 invalid_parameter"), { submissionOutcome: "rejected" }); } });
  await assert.rejects(rejected.submit({}), (error: any) => error instanceof PersistentVideoAdapterError && error.submissionOutcome === "rejected");
  const notSubmitted = good({ submitVideoTask: async () => ({ submissionOutcome: "not_submitted" }) });
  await assert.rejects(notSubmitted.submit({}), (error: any) => error instanceof PersistentVideoAdapterError && error.submissionOutcome === "not_submitted");
  const timeout = good({ submitVideoTask: async () => new Promise(() => {}), timeoutMs: 5 });
  await assert.rejects(timeout.submit({}), (error: any) => error instanceof PersistentVideoAdapterError && error.submissionOutcome === undefined);
});

test("an actual task receipt takes precedence over a contradictory rejection marker", async () => {
  const provider = good({ submitVideoTask: async () => ({ taskId: "accepted-task", submissionOutcome: "rejected" }) });
  assert.deepEqual(await provider.submit({}), { taskId: "accepted-task" });
});
