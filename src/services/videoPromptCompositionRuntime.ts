import u from "../utils";
import { getConfiguredMediaModel, getConfiguredTextOutputLimit } from "../utils/ai";
import { composeVideoPrompt } from "./videoPromptComposition";
import { prepareVideoPromptJob, type VideoPromptJob, type VideoPromptJobInput } from "./videoPromptJobs";
import { reviewGeneratedVideoPrompt } from "./videoPromptReview";
import { invokeVideoPromptReview } from "./videoPromptReviewRuntime";

/** Resolve all effective rules inside preparation, after the durable replay lookup. */
export async function prepareRuntimeVideoPromptJob(input: VideoPromptJobInput) {
  return prepareVideoPromptJob(u.db, input, { compose: async ({ db, scriptDuration, referenceCount }) => {
    const project = await db("o_project").where({ id: input.projectId }).select("artStyle").first();
    return composeVideoPrompt(db, { model: input.model, mode: input.mode, generation: input.generation, scriptDuration, referenceCount,
      capabilities: await getConfiguredMediaModel(input.model, "video"), visualManual: u.getArtPrompt(project?.artStyle || "无", "art_skills", "art_storyboard_video") },
      { skillsDir: u.getPath("skills"), modelPromptDir: u.getPath("modelPrompt") });
  } });
}
export async function generateRuntimeVideoPrompt(job: VideoPromptJob) {
  if (!job.compositionSnapshot) throw new Error("旧任务缺少提示词模板快照，请创建新的提示词任务");
  const response = await u.Ai.Text("universalAi").invoke({ system: job.compositionSnapshot.system, messages: [
    ...(job.compositionSnapshot.visualManual ? [{ role: "assistant" as const, content: job.compositionSnapshot.visualManual }] : []),
    { role: "user", content: job.promptInput },
  ] });
  return reviewGeneratedVideoPrompt(job, response.text, async (request) => invokeVideoPromptReview(
    request, (options) => u.Ai.Text("universalAi", true, 1).invoke(options), await getConfiguredTextOutputLimit("universalAi"),
  ));
}
