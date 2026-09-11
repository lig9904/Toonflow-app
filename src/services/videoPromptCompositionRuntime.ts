import u from "../utils";
import { getConfiguredMediaModel, getConfiguredTextOutputLimit } from "../utils/ai";
import { composeVideoPrompt } from "./videoPromptComposition";
import { prepareVideoPromptJob, type VideoPromptJob, type VideoPromptJobInput } from "./videoPromptJobs";
import { reviewGeneratedVideoPrompt } from "./videoPromptReview";
import type { VideoPromptReviewReport } from "../lib/videoPromptContract";
import { invokeVideoPromptReview } from "./videoPromptReviewRuntime";
import type { Knex } from "knex";
import type { VideoPromptCapabilities } from "./videoPromptComposition";
import { prepareVideoPromptForGeneration, type PreparedRuntimeVideoPrompt, type RuntimeVideoPromptHooks } from "./videoPromptCompositionService";
export type { PreparedRuntimeVideoPrompt, RuntimeVideoPromptHooks } from "./videoPromptCompositionService";

/** Resolve all effective rules inside preparation, after the durable replay lookup. */
export async function prepareRuntimeVideoPromptJob(input: VideoPromptJobInput, options: { db?: Knex; capabilities?: VideoPromptCapabilities; visualManual?: string } = {}) {
  const runtimeDb = options.db ?? u.db;
  return prepareVideoPromptJob(runtimeDb, input, { compose: async ({ db, scriptDuration, referenceCount }) => {
    const project = await db("o_project").where({ id: input.projectId }).select("artStyle").first();
    return composeVideoPrompt(db, { model: input.model, mode: input.mode, generation: input.generation, scriptDuration, referenceCount,
      capabilities: options.capabilities ?? await getConfiguredMediaModel(input.model, "video"), visualManual: options.visualManual ?? u.getArtPrompt(project?.artStyle || "无", "art_skills", "art_storyboard_video") },
      { skillsDir: u.getPath("skills"), modelPromptDir: u.getPath("modelPrompt") });
  } });
}
export async function generateRuntimeVideoPromptDraft(job: VideoPromptJob): Promise<string> {
  if (!job.compositionSnapshot) throw new Error("旧任务缺少提示词模板快照，请创建新的提示词任务");
  const response = await u.Ai.Text("universalAi").invoke({ system: job.compositionSnapshot.system, messages: [
    ...(job.compositionSnapshot.visualManual ? [{ role: "assistant" as const, content: job.compositionSnapshot.visualManual }] : []),
    { role: "user", content: job.promptInput },
  ] });
  return response.text;
}
export async function reviewRuntimeVideoPrompt(job: VideoPromptJob, draft: string): Promise<{ prompt: string; review: VideoPromptReviewReport }> {
  return reviewGeneratedVideoPrompt(job, draft, async (request) => invokeVideoPromptReview(
    request, (options) => u.Ai.Text("universalAi", true, 1).invoke(options), await getConfiguredTextOutputLimit("universalAi"),
  ));
}
export async function generateRuntimeVideoPrompt(job: VideoPromptJob) {
  return reviewRuntimeVideoPrompt(job, await generateRuntimeVideoPromptDraft(job));
}

/** Shared by Web and builtin Agent. A saved non-empty prompt is authoritative and is never rewritten. */
export async function prepareRuntimeVideoPromptForGeneration(input: VideoPromptJobInput, hooks: RuntimeVideoPromptHooks = {}, options: { db?: Knex; capabilities?: VideoPromptCapabilities; visualManual?: string } = {}): Promise<PreparedRuntimeVideoPrompt> {
  const db = options.db ?? u.db;
  return prepareVideoPromptForGeneration(db, input, {
    prepare: (value) => prepareRuntimeVideoPromptJob(value, { ...options, db }),
    generateDraft: generateRuntimeVideoPromptDraft,
    reviewDraft: reviewRuntimeVideoPrompt,
  }, hooks);
}
