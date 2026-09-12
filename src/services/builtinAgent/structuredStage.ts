import { StructuredModelOutputError } from "../../lib/structuredModelOutput";

export const formatRetryInstruction = "\n上次输出未通过 JSON 格式校验。本次重新生成完整 JSON，严格遵循 OUTPUT_JSON_SCHEMA 的字段类型与长度：字符串数组的每项必须是字符串，不能写成对象；不增加字段，不输出 Markdown 包裹。只修正输出格式，不改变任务范围，不重复已执行的保存或生成操作。";

/** Retry only a text format failure. Callers give each attempt its own durable,
 * budgeted model step; no business write or media submission is repeated here. */
export async function runStructuredStage<T>(execute: (attempt: 0 | 1) => Promise<T>, onRetry: () => Promise<void>): Promise<T> {
  try { return await execute(0); }
  catch (error) {
    if (!(error instanceof StructuredModelOutputError) || error.code !== "MODEL_OUTPUT_FORMAT") throw error;
    await onRetry();
    return execute(1);
  }
}
