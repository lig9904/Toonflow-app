/** A configured role limit may tighten a caller's budget, never enlarge it. */
export function textExecutionOptions(
  input: { temperature?: number; maxOutputTokens?: number },
  configured?: { temperature?: number | null; maxOutputTokens?: number | null } | null,
): { temperature?: number; maxOutputTokens?: number } {
  const caps = [input.maxOutputTokens, configured?.maxOutputTokens].filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
  const temperature = input.temperature ?? configured?.temperature;
  return {
    ...(typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {}),
    ...(caps.length ? { maxOutputTokens: Math.max(1, Math.floor(Math.min(...caps))) } : {}),
  };
}
