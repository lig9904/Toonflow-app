export type ImageGenerationMode = "text" | "singleImage" | "multiReference";

export interface RegisteredImageModel {
  modelName?: unknown;
  type?: unknown;
  mode?: unknown;
  enable?: unknown;
  enabled?: unknown;
}

export interface ResolvedImageModel {
  key: string;
  modelName: string;
  type: "image";
  mode: ImageGenerationMode[];
}

export class ImageModelSelectionError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "PROVIDER_DISABLED" | "MODEL_NOT_FOUND" | "MODEL_DISABLED" | "UNSUPPORTED_MODE" | "AMBIGUOUS_VARIANT",
    message: string,
  ) {
    super(message);
    this.name = "ImageModelSelectionError";
  }
}

const VERIFIED_SPLIT_FAMILIES = new Set(["seedream-v5-pro", "dola-seedream-5.0-pro"]);
const IMAGE_MODES = new Set<ImageGenerationMode>(["text", "singleImage", "multiReference"]);

/**
 * Selects an image model using registered, non-secret vendor metadata only.
 * Automatic T2I/I2I pairing is deliberately limited to the two documented
 * Seedream families; every other model must advertise the requested mode itself.
 */
export function resolveRegisteredImageModel(input: {
  requestedKey: string;
  providerEnabled: boolean;
  models: readonly unknown[];
  referenceCount: number;
}): ResolvedImageModel {
  const { vendorId, modelName } = parseKey(input.requestedKey);
  if (!Number.isSafeInteger(input.referenceCount) || input.referenceCount < 0) {
    throw new ImageModelSelectionError("INVALID_INPUT", "图片参考数量不合法");
  }
  if (!input.providerEnabled) throw new ImageModelSelectionError("PROVIDER_DISABLED", `图片模型供应商 ${vendorId} 未启用`);

  const registered = input.models.filter(isRecord);
  const selectedMatches = registered.filter((model) => model.modelName === modelName);
  if (selectedMatches.length !== 1) {
    if (selectedMatches.length > 1) throw new ImageModelSelectionError("AMBIGUOUS_VARIANT", `图片模型 ${input.requestedKey} 的注册元数据不唯一`);
    throw new ImageModelSelectionError("MODEL_NOT_FOUND", `未找到已注册图片模型 ${input.requestedKey}`);
  }
  const selected = selectedMatches[0];
  assertUsableImageModel(selected, input.requestedKey);
  if (supportsReferenceCount(selected, input.referenceCount)) return resolved(vendorId, selected);

  const familyMatch = modelName.match(/^(.*)-(t2i|i2i)$/);
  const family = familyMatch?.[1];
  if (!family || !VERIFIED_SPLIT_FAMILIES.has(family)) {
    throw new ImageModelSelectionError("UNSUPPORTED_MODE", unsupportedMessage(input.requestedKey, input.referenceCount));
  }

  const counterpartName = `${family}-${input.referenceCount === 0 ? "t2i" : "i2i"}`;
  const namedCounterparts = registered.filter((model) => model.modelName === counterpartName);
  const enabledCounterparts = namedCounterparts.filter((model) => !modelDisabled(model));
  if (namedCounterparts.length > 0 && enabledCounterparts.length === 0) {
    throw new ImageModelSelectionError("MODEL_DISABLED", `对应图片模型 ${vendorId}:${counterpartName} 已禁用`);
  }
  const candidates = enabledCounterparts.filter((model) => model.type === "image" && supportsReferenceCount(model, input.referenceCount));
  if (candidates.length === 0) {
    throw new ImageModelSelectionError("UNSUPPORTED_MODE", `同供应商中缺少支持当前参考数量的已注册对应模型 ${vendorId}:${counterpartName}`);
  }
  if (candidates.length !== 1 || namedCounterparts.length !== 1) {
    throw new ImageModelSelectionError("AMBIGUOUS_VARIANT", `对应图片模型 ${vendorId}:${counterpartName} 的注册元数据不唯一`);
  }
  return resolved(vendorId, candidates[0]);
}

export function imageModelSupportsReferenceCount(model: { mode?: unknown }, referenceCount: number): boolean {
  return supportsReferenceCount(model, referenceCount);
}

function parseKey(key: string): { vendorId: string; modelName: string } {
  if (typeof key !== "string") throw new ImageModelSelectionError("INVALID_INPUT", "图片模型键不合法");
  const separator = key.indexOf(":");
  const vendorId = separator > 0 ? key.slice(0, separator).trim() : "";
  const modelName = separator > 0 ? key.slice(separator + 1).trim() : "";
  if (!vendorId || !modelName) throw new ImageModelSelectionError("INVALID_INPUT", "图片模型键必须包含供应商和模型 ID");
  return { vendorId, modelName };
}

function assertUsableImageModel(model: Record<string, unknown>, key: string): void {
  if (modelDisabled(model)) throw new ImageModelSelectionError("MODEL_DISABLED", `图片模型 ${key} 已禁用`);
  if (model.type !== "image") throw new ImageModelSelectionError("MODEL_NOT_FOUND", `${key} 不是已注册图片模型`);
}

function modelDisabled(model: Record<string, unknown>): boolean {
  return model.enabled === false || model.enable === false || model.enable === 0 || model.enable === "0";
}

function supportsReferenceCount(model: { mode?: unknown }, referenceCount: number): boolean {
  const modes = normalizedModes(model.mode);
  if (referenceCount === 0) return modes.includes("text");
  if (referenceCount === 1) return modes.includes("singleImage") || modes.includes("multiReference");
  return modes.includes("multiReference");
}

function normalizedModes(value: unknown): ImageGenerationMode[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((mode): mode is ImageGenerationMode => typeof mode === "string" && IMAGE_MODES.has(mode as ImageGenerationMode)))];
}

function resolved(vendorId: string, model: Record<string, unknown>): ResolvedImageModel {
  const modelName = String(model.modelName);
  return { key: `${vendorId}:${modelName}`, modelName, type: "image", mode: normalizedModes(model.mode) };
}

function unsupportedMessage(key: string, referenceCount: number): string {
  if (referenceCount === 0) return `图片模型 ${key} 不支持无参考图生成`;
  if (referenceCount === 1) return `图片模型 ${key} 不支持单参考图生成`;
  return `图片模型 ${key} 不支持 ${referenceCount} 张参考图生成`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
