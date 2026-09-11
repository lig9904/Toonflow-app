import axios from "axios";
import u from "@/utils";
import { getPersistentImageTaskProvider, resolveConfiguredImageModel, getConfiguredMediaModel } from "@/utils/ai";
import type { ProductionImageRuntime } from "./productionImages";
import { createImageGenerationService, type ImageGenerationService } from "./imageJobs/runtime";
import { validateImageOutputSize } from "../lib/imageRequestCapabilities";
import { decodeAndValidateInlineImage, isInlineImageData, validateImageBytes, MAX_IMAGE_BYTES } from "./imageJobs/inlineImage";

let sharedJobs: ImageGenerationService | undefined;

export function getProductionImageGenerationService(): ImageGenerationService {
  if (!sharedJobs) {
    sharedJobs = createImageGenerationService({
      db: u.db,
      resolveModel: async (modelKey, referenceCount) => (await resolveConfiguredImageModel(modelKey, referenceCount)).key,
      validateConfig: async (modelKey, config) => {
        const model = await getConfiguredMediaModel(modelKey, "image");
        validateImageOutputSize(modelKey, config.size, model);
        if (Array.isArray(model.resolutions) && !model.resolutions.includes(config.size)) throw new Error(`当前图片模型不支持 ${config.size}；可选质量：${model.resolutions.join("、")}`);
      },
      providerFor: (modelKey) => getPersistentImageTaskProvider(modelKey as `${string}:${string}`),
      download: async (url, outputPath) => {
        const inline = isInlineImageData(url);
        const bytes = inline
          ? await decodeAndValidateInlineImage(url)
          : Buffer.from((await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 60_000, maxContentLength: MAX_IMAGE_BYTES, maxBodyLength: MAX_IMAGE_BYTES })).data);
        if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("图片结果超过 40MB 限制");
        if (!inline) await validateImageBytes(bytes);
        await u.oss.writeFile(outputPath, bytes);
      },
      getSmallImageUrl: (path) => u.oss.getSmallImageUrl(path),
      uuid: () => u.uuid(),
    });
  }
  return sharedJobs;
}

export function createDurableProductionImageRuntime(): ProductionImageRuntime {
  return {
    getArtPrompt: (style, source, fileName) => u.getArtPrompt(style, source, fileName),
    generatePrompt: async ({ system, parentDescription, description }) => {
      const { text } = await u.Ai.Text("universalAi").invoke({ system, messages: [{ role: "user", content: `父级资产描述: ${parentDescription}\n当前资产描述: ${description}` }] });
      return text;
    },
    imageJobs: getProductionImageGenerationService(),
    getImageBase64: (path) => u.oss.getImageBase64(path),
    getSmallImageUrl: (path) => u.oss.getSmallImageUrl(path),
    uuid: () => u.uuid(),
  };
}
