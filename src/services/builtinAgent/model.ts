import fs from "node:fs/promises";
import path from "node:path";
import { Output } from "ai";
import { z } from "zod";
import u from "../../utils";
import type { StructuredScriptModel } from "./scriptExecutor";

/** Reuses the configured builtin role slots and provider runtime; credentials stay server-side. */
export const configuredScriptModel: StructuredScriptModel = {
  async generate(request) {
    const response = await u.Ai.Text(request.role).invoke({
      // Some configured OpenAI-compatible models offer JSON mode but omit native JSON Schema.
      // Keep the schema explicit in the prompt and still validate the response locally.
      system: request.system + "\n\nOUTPUT_JSON_SCHEMA\n" + JSON.stringify(z.toJSONSchema(request.schema)) + "\n仅返回符合该 schema 的 JSON 对象。",
      prompt: JSON.stringify(request.input),
      output: Output.object({ schema: request.schema }),
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: request.signal,
      maxRetries: 0,
    });
    return { value: request.schema.parse(response.output), outputTokens: Number(response.usage.outputTokens ?? 0) };
  },
};

export async function loadBuiltinSkill(name: string): Promise<string> {
  if (!/^[a-z_]+\.md$/.test(name)) throw new Error("Invalid builtin skill name");
  return fs.readFile(path.join(u.getPath("skills"), name), "utf8");
}
