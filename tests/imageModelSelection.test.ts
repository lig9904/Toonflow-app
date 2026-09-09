import assert from "node:assert/strict";
import test from "node:test";
import { ImageModelSelectionError, resolveRegisteredImageModel } from "../src/lib/imageModelSelection";

const seedreamModels = [
  { modelName: "seedream-v5-pro-t2i", type: "image", mode: ["text"] },
  { modelName: "seedream-v5-pro-i2i", type: "image", mode: ["singleImage", "multiReference"] },
  { modelName: "dola-seedream-5.0-pro-t2i", type: "image", mode: ["text"] },
  { modelName: "dola-seedream-5.0-pro-i2i", type: "image", mode: ["singleImage", "multiReference"] },
];

test("keeps the selected image model whenever its own metadata supports the operation", () => {
  const generic = { modelName: "generic-flex", type: "image", mode: ["text", "singleImage", "multiReference"] };
  for (const referenceCount of [0, 1, 3]) {
    assert.equal(resolveRegisteredImageModel({ requestedKey: "vendor-a:generic-flex", providerEnabled: true, models: [generic], referenceCount }).key, "vendor-a:generic-flex");
  }
});

test("pairs only the documented Seedream T2I and I2I variants from the same vendor", () => {
  assert.equal(resolveRegisteredImageModel({ requestedKey: "vendor-a:seedream-v5-pro-t2i", providerEnabled: true, models: seedreamModels, referenceCount: 1 }).key, "vendor-a:seedream-v5-pro-i2i");
  assert.equal(resolveRegisteredImageModel({ requestedKey: "vendor-a:seedream-v5-pro-i2i", providerEnabled: true, models: seedreamModels, referenceCount: 0 }).key, "vendor-a:seedream-v5-pro-t2i");
  assert.equal(resolveRegisteredImageModel({ requestedKey: "vendor-a:dola-seedream-5.0-pro-t2i", providerEnabled: true, models: seedreamModels, referenceCount: 2 }).key, "vendor-a:dola-seedream-5.0-pro-i2i");
});

test("never crosses model families or guesses an unregistered model ID", () => {
  const onlyDolaI2I = seedreamModels.filter((model) => model.modelName !== "seedream-v5-pro-i2i");
  assert.throws(
    () => resolveRegisteredImageModel({ requestedKey: "vendor-a:seedream-v5-pro-t2i", providerEnabled: true, models: onlyDolaI2I, referenceCount: 1 }),
    (error: unknown) => error instanceof ImageModelSelectionError && error.code === "UNSUPPORTED_MODE" && /seedream-v5-pro-i2i/.test(error.message),
  );
  assert.throws(
    () => resolveRegisteredImageModel({ requestedKey: "vendor-a:unknown-t2i", providerEnabled: true, models: [{ modelName: "unknown-t2i", type: "image", mode: ["text"] }, { modelName: "unknown-i2i", type: "image", mode: ["singleImage"] }], referenceCount: 1 }),
    (error: unknown) => error instanceof ImageModelSelectionError && error.code === "UNSUPPORTED_MODE",
  );
});

test("clearly rejects disabled providers, disabled counterparts and ambiguous metadata", () => {
  assert.throws(
    () => resolveRegisteredImageModel({ requestedKey: "vendor-a:seedream-v5-pro-t2i", providerEnabled: false, models: seedreamModels, referenceCount: 0 }),
    (error: unknown) => error instanceof ImageModelSelectionError && error.code === "PROVIDER_DISABLED",
  );
  assert.throws(
    () => resolveRegisteredImageModel({ requestedKey: "vendor-a:seedream-v5-pro-t2i", providerEnabled: true, models: seedreamModels.map((model) => model.modelName === "seedream-v5-pro-i2i" ? { ...model, enabled: false } : model), referenceCount: 1 }),
    (error: unknown) => error instanceof ImageModelSelectionError && error.code === "MODEL_DISABLED",
  );
  assert.throws(
    () => resolveRegisteredImageModel({ requestedKey: "vendor-a:seedream-v5-pro-t2i", providerEnabled: true, models: [...seedreamModels, { ...seedreamModels[1] }], referenceCount: 1 }),
    (error: unknown) => error instanceof ImageModelSelectionError && error.code === "AMBIGUOUS_VARIANT",
  );
});
