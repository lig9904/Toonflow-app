import fs from "node:fs/promises";
import path from "node:path";
import { Output } from "ai";
import { z } from "zod";
import u from "../../utils";
import type { StructuredScriptModel } from "./scriptExecutor";
import { readStructuredModelOutput, collectStructuredStream } from "../../lib/structuredModelOutput";
import { getConfiguredTextOutputLimit } from "../../utils/ai";

/** Reuses the configured builtin role slots and provider runtime; credentials stay server-side. */
export const configuredScriptModel: StructuredScriptModel = {
  async generate(request) {
    // Routing only selects IDs and actions. Reasoning-enabled providers can use
    // this short output budget before emitting any JSON, so keep decision calls
    // non-thinking while preserving the configured behavior of creative roles.
    const thinking = request.role.endsWith(":decisionAgent") ? false : request.thinkLevel > 0;
    const limit = request.useModelOutputLimit ? await getConfiguredTextOutputLimit(request.role) : request.maxOutputTokens;
    const result = await readStructuredModelOutput({ ...request, maxOutputTokens: limit ?? 0 }, async (onFinish) => {
      const options = {
      // Some configured OpenAI-compatible models offer JSON mode but omit native JSON Schema.
      // Keep the schema explicit in the prompt and still validate the response locally.
      system: "当前执行环境是服务器结构化步骤。输入已包含所需工作区，当前没有工具。下方专业参考中的旧工具名、XML、前端回调和保存步骤不再执行，只借鉴创作标准。实际保存由服务器完成。\n<professional_reference>\n" + request.system + "\n</professional_reference>\n\n当前输出协议优先：仅返回完整且紧凑的 JSON，不调用工具，不输出 XML 或额外解说，不声称已派发或保存。不要重复输入全文。\nOUTPUT_JSON_SCHEMA\n" + JSON.stringify(z.toJSONSchema(request.schema)),
      prompt: JSON.stringify(request.input),
      output: Output.object({ schema: request.schema }),
      ...(limit === undefined ? {} : { maxOutputTokens: limit }),
      abortSignal: request.signal,
      maxRetries: 0,
      onFinish,
      };
      const ai = u.Ai.Text(request.role, thinking, request.thinkLevel);
      if (!request.onPartial) return ai.invoke(options);
      const stream = await ai.stream(options);
      return collectStructuredStream(stream, request.onPartial);
    });
    return { ...result, ...(request.useModelOutputLimit && limit !== undefined ? { maxOutputTokens: limit } : {}) };
  },
};

export async function loadBuiltinSkill(name: string): Promise<string> {
  if (!/^[a-z_]+\.md$/.test(name)) throw new Error("Invalid builtin skill name");
  return fs.readFile(path.join(u.getPath("skills"), name), "utf8");
}
