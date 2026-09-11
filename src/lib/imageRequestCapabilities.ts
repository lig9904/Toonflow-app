/** Mirrors the registered Seedance NZ adapter's supported output sizes. */
export function imageOutputSizes(modelKey: string, model?: { resolutions?: unknown; sizes?: unknown }): string[] {
  if (/^zhenzhenRelay:(?:seedream-v5-pro|dola-seedream-5\.0-pro)-(?:t2i|i2i)$/.test(modelKey)) return ["1K", "2K"];
  const declared = Array.isArray(model?.resolutions) ? model.resolutions : model?.sizes;
  if (Array.isArray(declared)) return [...new Set(declared.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 50))];
  // Existing vendor templates use the 1K/2K/4K ImageConfig contract. A vendor
  // can narrow or replace it through explicit per-model resolutions metadata.
  return ["1K", "2K", "4K"];
}

export function validateImageOutputSize(modelKey: string, size: string, model?: { resolutions?: unknown; sizes?: unknown }): void {
  if (/^zhenzhenRelay:(?:seedream-v5-pro|dola-seedream-5\.0-pro)-(?:t2i|i2i)$/.test(modelKey) && !["1K", "2K"].includes(size)) {
    throw new Error(`当前 Seedream 接口仅支持 1K/2K，项目选择了 ${size}；请在项目设置中改为 1K 或 2K`);
  }
  const allowed = imageOutputSizes(modelKey, model);
  if (!allowed.includes(size)) throw new Error(`当前图片模型不支持 ${size}；可选质量：${allowed.join("、")}`);
}
