import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPostgresFixture } from "../src/lib/postgresTest";
import { promptDefaults } from "../src/lib/promptDefaults";
import { readManagedPrompt, listManagedPrompts, saveManagedPrompt, resetManagedPrompt, restoreManagedPrompt, listPromptHistory, capturePromptSnapshot, promptDefinitions } from "../src/services/promptRegistry";
const options = { skip: !process.env.TOONFLOW_TEST_DATABASE_URL };
const paths = { skillsDir: path.resolve("data/skills"), modelPromptDir: path.resolve("data/modelPrompt") };
async function fixture() {
  const f = await createPostgresFixture();
  await f.db.schema.createTable("o_prompt", t => { t.increments("id"); t.text("name"); t.text("type"); t.text("data"); t.text("useData"); });
  return f;
}
const actor = { id: "human:7" };
test("common defaults migrate without losing legacy overrides; writes use CAS, idempotency, history and reset", options, async () => {
  const f = await fixture();
  try {
    await f.db("o_prompt").insert({ name: "资产", type: "scriptAssetExtraction", data: "legacy default", useData: "my identity rules" });
    await f.db("o_prompt").insert({ name: "事件", type: "eventExtraction", data: "legacy event", useData: " \n " });
    const key = "common.scriptAssetExtraction";
    const start = await readManagedPrompt(f.db, key, paths);
    assert.equal((await f.db("o_prompt").where("type", "eventExtraction").first()).useData, null);
    assert.equal(start.content, "my identity rules"); assert.equal(start.defaultContent, promptDefaults.scriptAssetExtraction);
    assert.equal((await f.db("o_prompt").where("type", "scriptAssetExtraction").first()).data, promptDefaults.scriptAssetExtraction);
    const input = { actor, content: "new identity rules", expectedVersion: start.version, idempotencyKey: "prompt-save-001" };
    const changed = await saveManagedPrompt(f.db, key, input, paths);
    assert.notEqual(changed.version, start.version);
    assert.equal((await f.db("o_prompt").where("type", "scriptAssetExtraction").first()).useData, input.content);
    assert.deepEqual(await saveManagedPrompt(f.db, key, input, paths), changed);
    await assert.rejects(saveManagedPrompt(f.db, key, { ...input, content: "different" }, paths), /不同内容/);
    await assert.rejects(saveManagedPrompt(f.db, key, { ...input, idempotencyKey: "prompt-stale-001" }, paths), (e: any) => e.code === "VERSION_CONFLICT" && e.currentVersion === changed.version);
    for (const content of ["", " \n ", 4, null]) await assert.rejects(saveManagedPrompt(f.db, key, { ...input, content: content as any }, paths), /非空文本/);
    const reset = await resetManagedPrompt(f.db, key, { actor, expectedVersion: changed.version, idempotencyKey: "prompt-reset-001" }, paths);
    assert.equal(reset.customized, false); assert.equal(reset.content, promptDefaults.scriptAssetExtraction);
    const restored = await restoreManagedPrompt(f.db, key, { actor, expectedVersion: reset.version, historyVersion: start.version, idempotencyKey: "prompt-restore-001" }, paths);
    assert.equal(restored.content, start.content);
    assert.equal((await listPromptHistory(f.db, key, paths)).items.length, 4);
  } finally { await f.destroy(); }
});
test("concurrent editors cannot overwrite and exact snapshots stay stable after writes", options, async () => {
  const f = await fixture();
  try {
    const key = "review.generatedImageReview"; const entry = await readManagedPrompt(f.db, key, paths);
    const results = await Promise.allSettled(["first review", "second review"].map((content, i) => saveManagedPrompt(f.db, key, { actor, content, expectedVersion: entry.version, idempotencyKey: `parallel-save-${i}` }, paths)));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected" && r.reason.code === "VERSION_CONFLICT").length, 1);
    const snapshot = await capturePromptSnapshot(f.db, paths);
    assert.equal(Object.keys(snapshot).length, 23);
    const current = snapshot[key]; await resetManagedPrompt(f.db, key, { actor, expectedVersion: current.version, idempotencyKey: "snapshot-reset-001" }, paths);
    assert.equal(snapshot[key].content, current.content); assert.notEqual((await readManagedPrompt(f.db, key, paths)).version, current.version);
  } finally { await f.destroy(); }
});
test("all 23 entries read whitelisted real defaults; file edits preserved and stale file versions conflict", options, async () => {
  const f = await fixture(); const temp = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-registry-"));
  try {
    const entries = await listManagedPrompts(f.db, paths);
    assert.equal(entries.length, 23); assert.equal(new Set(entries.map(p => p.key)).size, 23);
    assert.equal(entries.filter(p => p.group === "skill").length, 10);
    assert.ok(entries.every(p => p.content.trim() && p.editable && p.requiredContext.length));
    const key = "skill.builtin_production_review"; const file = "builtin_production_review.md";
    await fs.writeFile(path.join(temp, file), "locally customized file"); const localPaths = { ...paths, skillsDir: temp };
    const before = await readManagedPrompt(f.db, key, localPaths); assert.equal(before.content, "locally customized file");
    const saved = await saveManagedPrompt(f.db, key, { actor, content: "database override", expectedVersion: before.version, idempotencyKey: "file-save-001" }, localPaths);
    assert.equal(await fs.readFile(path.join(temp, file), "utf8"), "locally customized file");
    await fs.writeFile(path.join(temp, file), "new local default");
    await assert.rejects(resetManagedPrompt(f.db, key, { actor, expectedVersion: saved.version, idempotencyKey: "stale-file-reset" }, localPaths), (e: any) => e.code === "VERSION_CONFLICT");
    const current = await readManagedPrompt(f.db, key, localPaths);
    const reset = await resetManagedPrompt(f.db, key, { actor, expectedVersion: current.version, idempotencyKey: "fresh-file-reset" }, localPaths);
    assert.equal(reset.content, "new local default");
    await assert.rejects(readManagedPrompt(f.db, "skill.../../secret", localPaths), /不存在/);
    await fs.unlink(path.join(temp, file)); await fs.symlink(path.resolve("package.json"), path.join(temp, file));
    await assert.rejects(readManagedPrompt(f.db, key, localPaths), /默认文件不可用/);
    assert.equal(promptDefinitions.filter(p => p.group === "review").length, 2);
  } finally { await fs.rm(temp, { recursive: true, force: true }); await f.destroy(); }
});
