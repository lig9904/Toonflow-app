export function parseCustomModels(raw: unknown): any[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function upsertVendorModel(raw: unknown, modelName: string, model: any): string {
  let models: any[];
  if (typeof raw !== "string" || !raw.trim()) models = [];
  else {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error("供应商模型配置损坏"); }
    if (!Array.isArray(parsed)) throw new Error("供应商模型配置格式无效");
    models = parsed;
  }
  const nextModelName = model?.modelName;
  if (typeof nextModelName !== "string" || !nextModelName) throw new Error("modelName无效");
  const index = models.findIndex((item) => item && item.modelName === modelName);
  const conflict = models.some((item, itemIndex) => itemIndex !== index && item?.modelName === nextModelName);
  if (conflict) throw new Error("模型ID已存在");
  if (index >= 0) models[index] = models[index]?.modelName === nextModelName && models[index]?.type === model.type ? { ...models[index], ...model } : model;
  else models.push(model);
  return JSON.stringify(models);
}

export function sortVendorConfigRows<T extends { id?: string | null }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    const leftId = String(left.id ?? "");
    const rightId = String(right.id ?? "");
    if (leftId === "toonflow" && rightId !== "toonflow") return -1;
    if (rightId === "toonflow" && leftId !== "toonflow") return 1;
    return leftId.localeCompare(rightId);
  });
}

/** A name-only customization must not erase the same registered model's capabilities. Explicit overrides still win. */
export function mergeVendorModels(defaults:any[],custom:any[]):any[]{
 const models=new Map<string,any>();
 for(const item of [...defaults,...custom]){
   const prior=models.get(item.modelName);
   models.set(item.modelName,prior && prior.type===item.type ? {...prior,...item} : {...item});
 }
 return [...models.values()];
}
