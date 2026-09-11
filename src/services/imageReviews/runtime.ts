import u from "../../utils";
import { getConfiguredTextVisionModel } from "../../utils/ai";
import { readManagedPrompt } from "../promptRegistry";
import { notifyProductionChange } from "../productionEvents";
import { ImageReviewService } from ".";
import { localReviewImageReader } from "./media";

let shared: ImageReviewService | undefined;
export function getProductionImageReviewService(): ImageReviewService {
  return shared ??= new ImageReviewService({
    db: u.db,
    readImage: localReviewImageReader(u.getPath("oss")),
    readPrompt: () => readManagedPrompt(u.db, "review.generatedImageReview", { skillsDir: u.getPath("skills"), modelPromptDir: u.getPath("modelPrompt") }),
    resolveModel: () => getConfiguredTextVisionModel("universalAi"),
    generate: async ({ model, system, content, signal }) => {
      // Use the exact configured model that passed capability verification; no fallback provider or key.
      const result = await u.Ai.Text(model.key as `${string}:${string}`, false).invoke({ system, messages: [{ role: "user", content }], abortSignal: signal, maxRetries: 0, maxOutputTokens: 4096 });
      return result.text;
    },
    onChanged: notifyProductionChange,
  });
}
