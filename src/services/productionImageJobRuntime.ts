import axios from "axios";
import sharp from "sharp";
import u from "@/utils";
import { getPersistentImageTaskProvider, resolveConfiguredImageModel } from "@/utils/ai";
import type { ProductionImageRuntime } from "./productionImages";
import { createImageGenerationService, type ImageGenerationService } from "./imageJobs/runtime";

let sharedJobs: ImageGenerationService | undefined;

export function getProductionImageGenerationService(): ImageGenerationService {
  if (!sharedJobs) {
    sharedJobs = createImageGenerationService({
      db: u.db,
      resolveModel: async (modelKey, referenceCount) => (await resolveConfiguredImageModel(modelKey, referenceCount)).key,
      providerFor: (modelKey) => getPersistentImageTaskProvider(modelKey as `${string}:${string}`),
      download: async (url, outputPath) => {
        const response = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 60_000, maxContentLength: 40 * 1024 * 1024 });
        const bytes = Buffer.from(response.data);
        const metadata = await sharp(bytes).metadata();
        if (!metadata.width || !metadata.height || !metadata.format) throw new Error("上游返回的文件不是可解码图片");
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
