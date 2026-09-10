/** Provider metadata may declare a cap; context length is never an output cap. */
export function textModelOutputLimit(input: {
  modelName: string; baseUrl?: string; declaredMaxOutputTokens?: unknown; configuredMaxOutputTokens?: unknown;
}): number | undefined {
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  let officialLimit: number | undefined;
  try {
    const url = new URL(input.baseUrl ?? "");
    // Verified official Chat Completions capability, 2026-09-10:
    // https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono/
    // Do not assume that a relay with the same model name accepts this limit.
    if (url.protocol === "https:" && url.hostname === "api.deepseek.com" && ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(input.modelName)) officialLimit = 384000;
  } catch { /* Unknown endpoint: rely only on declared/configured capabilities. */ }
  const limits = [officialLimit, input.declaredMaxOutputTokens, input.configuredMaxOutputTokens].filter(positive);
  return limits.length ? Math.min(...limits) : undefined;
}
