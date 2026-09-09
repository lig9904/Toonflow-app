import u from "@/utils";
import type { ProductionImageRuntime } from "./productionImages";

export function createProductionImageRuntime(): ProductionImageRuntime {
  return {
    getArtPrompt: (style, source, fileName) => u.getArtPrompt(style, source, fileName),
    generatePrompt: async ({ system, parentDescription, description }) => {
      const { text } = await u.Ai.Text("universalAi").invoke({ system, messages: [{ role: "user", content: `父级资产描述: ${parentDescription}\n当前资产描述: ${description}` }] });
      return text;
    },
    generateImage: async ({ model, prompt, size, aspectRatio, referenceList, projectId, kind }) => u.Ai.Image(model as `${string}:${string}`).run(
      { prompt, size, aspectRatio, referenceList },
      { taskClass: "生成图片", describe: kind === "asset" ? "资产图片生成" : "分镜图片生成", relatedObjects: JSON.stringify({ prompt, size, aspectRatio }), projectId },
    ),
    getImageBase64: (path) => u.oss.getImageBase64(path),
    getSmallImageUrl: (path) => u.oss.getSmallImageUrl(path),
    uuid: () => u.uuid(),
  };
}
