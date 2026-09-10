/** Mirrors the registered Seedance NZ adapter's supported output sizes. */
export function imageOutputSizes(modelKey: string, model?: { resolutions?: unknown }): string[] {
  if (/^zhenzhenRelay:(?:seedream-v5-pro|dola-seedream-5\.0-pro)-(?:t2i|i2i)$/.test(modelKey)) return ["1K", "2K"];
  if (Array.isArray(model?.resolutions)) return [...new Set(model.resolutions.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 50))];
  // Existing vendor templates use the 1K/2K/4K ImageConfig contract. A vendor
  // can narrow or replace it through explicit per-model resolutions metadata.
  return ["1K", "2K", "4K"];
}

export function validateImageOutputSize(modelKey: string, size: string): void {
  if (/^zhenzhenRelay:(?:seedream-v5-pro|dola-seedream-5\.0-pro)-(?:t2i|i2i)$/.test(modelKey) && !["1K", "2K"].includes(size)) {
    throw new Error(`当前 Seedream 接口仅支持 1K/2K，项目选择了 ${size}；请在项目设置中改为 1K 或 2K`);
  }
}
