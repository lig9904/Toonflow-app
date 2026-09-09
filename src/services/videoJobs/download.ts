/** The deadline includes reading the response body, not only receiving headers. */
export async function fetchVideoBytes(url: string, timeoutMs = 60_000): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Video download failed (HTTP ${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}
