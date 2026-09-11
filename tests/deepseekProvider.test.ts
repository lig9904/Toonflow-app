import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "sucrase";
import { VM } from "vm2";

function fixture() {
  const exported: any = {};
  let sent: any;
  const code = fs.readFileSync("data/vendor/deepseek.ts", "utf8");
  new VM({ sandbox: { exports: exported,
    fetch: async (_url: string, options: any) => { sent = JSON.parse(options.body); return {}; },
    createOpenAICompatible: (options: any) => ({ chatModel: (model: string) => ({ invoke: () => options.fetch("https://api.deepseek.com/chat/completions", { body: JSON.stringify({ model, messages: [] }) }) }) }),
  } }).run(transform(code, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, ""));
  exported.vendor.inputValues.apiKey = "fixture-key";
  return { exported, code, sent: () => sent };
}

test("DeepSeek template and fresh-install bundle expose the verified V4.1 identifier", () => {
  const f = fixture();
  assert.deepEqual(f.exported.vendor.models.map((model: any) => model.modelName), ["deepseek-flash"]);
  assert.equal(f.exported.vendor.models[0].maxOutputTokens, 384000);
  assert.equal(JSON.parse(fs.readFileSync("src/lib/vendor.json", "utf8"))["deepseek.ts"], f.code);
});

test("DeepSeek V4.1 preserves thinking switch and maps light/deep/extreme effort", async () => {
  const f = fixture();
  const model = f.exported.vendor.models[0];
  for (const [level, effort] of [[1, "low"], [2, "high"], [3, "max"]] as const) {
    await f.exported.textRequest(model, true, level).invoke();
    assert.equal(f.sent().model, "deepseek-flash");
    assert.equal(f.sent().thinking.type, "enabled");
    assert.equal(f.sent().reasoning_effort, effort);
  }
  await f.exported.textRequest(model, false, 0).invoke();
  assert.equal(f.sent().thinking.type, "disabled");
  assert.equal(f.sent().reasoning_effort, undefined);
});
