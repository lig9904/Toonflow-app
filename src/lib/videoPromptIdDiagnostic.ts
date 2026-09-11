/** Whitelisted request metadata only: never include prompts, cookies or keys. */
export function videoPromptIdDiagnostic(path: string, body: unknown): Record<string, unknown> | undefined {
  if (!/^\/api\/production\/workbench\/(generateVideoPrompt|batchGeneratePrompt|checkVideoPrompt)$/.test(path)) return undefined;
  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const describe = (field: string, value: unknown) => {
    const numeric = typeof value === "number" || (typeof value === "string" && /^\d{1,16}$/.test(value)) ? Number(value) : undefined;
    return { field, kind: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
      valid: numeric !== undefined && Number.isSafeInteger(numeric) && numeric > 0,
      ...(numeric !== undefined && Number.isFinite(numeric) ? { value: numeric } : {}) };
  };
  const ids = [describe("projectId", input.projectId), describe("scriptId", input.scriptId)];
  if (path.endsWith("/generateVideoPrompt")) ids.push(describe("trackId", input.trackId));
  if (path.endsWith("/batchGeneratePrompt") && Array.isArray(input.trackData)) input.trackData.slice(0, 100).forEach((track, index) => ids.push(describe(`trackData[${index}].trackId`, track?.trackId)));
  if (path.endsWith("/checkVideoPrompt") && Array.isArray(input.trackIds)) input.trackIds.slice(0, 100).forEach((id, index) => ids.push(describe(`trackIds[${index}]`, id)));
  return { route: path, ids, hasIdempotencyKey: typeof input.idempotencyKey === "string", hasExpectedVersion: input.expectedVersion !== undefined };
}
