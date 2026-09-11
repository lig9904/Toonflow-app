import u from "../../utils";
import { getConfiguredTextVisionModel } from "../../utils/ai";
import { readManagedPrompt } from "../promptRegistry";
import { notifyProductionChange } from "../productionEvents";
import { ImageReviewService } from ".";
import { imageReviewSdkContent, localReviewImageReader } from "./media";
import { diagnoseImageReviewFailure, ImageReviewDiagnosticError, type ImageReviewModelResponse } from "./output";

let shared: ImageReviewService | undefined;
export function getProductionImageReviewService(): ImageReviewService {
  return shared ??= new ImageReviewService({
    db: u.db,
    readImage: localReviewImageReader(u.getPath("oss")),
    readPrompt: () => readManagedPrompt(u.db, "review.generatedImageReview", { skillsDir: u.getPath("skills"), modelPromptDir: u.getPath("modelPrompt") }),
    resolveModel: () => getConfiguredTextVisionModel("universalAi"),
    generate: async ({ model, system, content, signal }) => {
      // Use the exact configured model that passed capability verification; no fallback provider or key.
      try {
        const result = await u.Ai.Text(model.key as `${string}:${string}`, false).invoke({ system, messages: [{ role: "user", content: imageReviewSdkContent(content) }], abortSignal: signal, maxRetries: 0, maxOutputTokens: 4096 });
        let sentImageCount: number | undefined;
        try {
          const body = typeof result.request?.body === "string" ? JSON.parse(result.request.body) : result.request?.body;
          if (body && typeof body === "object") {
            const request = body as { messages?: Array<{ content?: unknown }>; contents?: Array<{ parts?: unknown }> };
            const parts = request.messages?.flatMap((message) => Array.isArray(message.content) ? message.content : []) ?? request.contents?.flatMap((message) => Array.isArray(message.parts) ? message.parts : []);
            if (parts) sentImageCount = parts.filter((part) => part?.type === "image_url" || part?.type === "input_image" || part?.type === "image" || /^image\//.test(part?.inlineData?.mimeType ?? part?.fileData?.mimeType ?? "")).length;
          }
        } catch { /* Only extract a count; never persist the body or image bytes. */ }
        const response: ImageReviewModelResponse = { kind: "image-review-model-response", text: result.text, finishReason: result.finishReason, maxOutputTokens: 4096, usage: result.usage,
          expectedImageCount: content.filter((part) => part.type === "image").length, sentImageCount,
          unsupportedImageParts: (result.warnings ?? []).filter((warning: any) => warning.type === "unsupported" && /\b(?:image|file)\b/i.test(String(warning.feature ?? ""))).length };
        return response;
      } catch (error) { throw new ImageReviewDiagnosticError(diagnoseImageReviewFailure(error, "model_request")); }
    },
    onChanged: notifyProductionChange,
  });
}
