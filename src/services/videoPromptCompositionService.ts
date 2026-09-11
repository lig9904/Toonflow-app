import type { Knex } from "knex";
import type { VideoPromptReviewReport } from "../lib/videoPromptContract";
import { executeVideoPromptJob, findVideoPromptJobByIdempotency, VideoPromptJobError, type VideoPromptJob, type VideoPromptJobInput } from "./videoPromptJobs";
import { preflightVideoPrompt } from "./videoPromptReview";

export interface RuntimeVideoPromptHooks {
  generateDraft?: (job: VideoPromptJob, invoke: () => Promise<string>) => Promise<string>;
  reviewDraft?: (job: VideoPromptJob, draft: string, invoke: () => Promise<{ prompt: string; review: VideoPromptReviewReport }>) => Promise<{ prompt: string; review: VideoPromptReviewReport }>;
}
export interface PreparedRuntimeVideoPrompt {
  prompt: string;
  promptReview: VideoPromptReviewReport;
  source: "saved" | "generated";
  stale: boolean;
  trackVersion: number;
  promptJobId?: string;
}
export interface VideoPromptPreparationActions {
  prepare(input: VideoPromptJobInput): Promise<{ job: VideoPromptJob; reused: boolean }>;
  generateDraft(job: VideoPromptJob): Promise<string>;
  reviewDraft(job: VideoPromptJob, draft: string): Promise<{ prompt: string; review: VideoPromptReviewReport }>;
}

function validateRequest(input: VideoPromptJobInput): void {
  for (const [name, value] of [["projectId", input.projectId], ["scriptId", input.scriptId], ["trackId", input.trackId]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new VideoPromptJobError("INVALID_INPUT", `${name} 无效`);
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new VideoPromptJobError("INVALID_INPUT", "缺少有效轨道版本");
  if (typeof input.idempotencyKey !== "string" || !/^[\w:.-]{8,150}$/.test(input.idempotencyKey)) throw new VideoPromptJobError("INVALID_INPUT", "缺少有效提示词任务编号");
  if (typeof input.model !== "string" || !input.model.trim() || typeof input.mode !== "string" || !Array.isArray(input.info)) throw new VideoPromptJobError("INVALID_INPUT", "模型、模式或参考无效");
}

async function currentTrack(db: Knex, input: VideoPromptJobInput) {
  const track = await db("o_videoTrack").where({ id: input.trackId, projectId: input.projectId, scriptId: input.scriptId }).first();
  if (!track) throw new VideoPromptJobError("CONFLICT", "视频轨道不属于当前项目或剧集");
  const state = await db("ext_creative_state").where({ entityType: "track", entityId: input.trackId, projectId: input.projectId }).first();
  return { track, version: Number(state?.version ?? 0), updatedAt: Number(state?.updatedAt ?? 0) };
}

async function savedPromptStale(db: Knex, input: VideoPromptJobInput, trackUpdatedAt: number): Promise<boolean> {
  if (!trackUpdatedAt) return false;
  const boards = await db("o_storyboard").where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId }).select("id");
  if (!boards.length) return false;
  const newer = await db("ext_entity_state").where({ projectId: input.projectId, entityType: "storyboard" }).where((query) => {
    for (const board of boards) query.orWhere("entityId", Number(board.id));
  }).whereRaw("?? > ?", ["updatedAt", trackUpdatedAt]).first();
  return Boolean(newer);
}

/** Pure database orchestration. Callers inject runtime model actions and may wrap them with the parent Agent's model-call budget. */
export async function prepareVideoPromptForGeneration(db: Knex, input: VideoPromptJobInput, actions: VideoPromptPreparationActions, hooks: RuntimeVideoPromptHooks = {}): Promise<PreparedRuntimeVideoPrompt> {
  validateRequest(input);
  const replay = await findVideoPromptJobByIdempotency(db, input);
  if (!replay) {
    const current = await currentTrack(db, input);
    if (current.version !== input.expectedVersion) throw new VideoPromptJobError("VERSION_CONFLICT", "轨道已被其他成员或任务修改，请读取最新版本");
    const prompt = String(current.track.prompt ?? "");
    if (prompt.trim()) {
      const review = await preflightVideoPrompt(db, { projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, prompt, model: input.model, mode: input.mode, generation: input.generation ?? {}, info: input.info });
      const stale = await savedPromptStale(db, input, current.updatedAt);
      if (stale) {
        review.status = "issues";
        review.findings = [...review.findings, { code: "PROMPT_SOURCE_STALE", severity: "warning", field: "source", message: "源分镜在该人工提示词保存后发生变化；已保留人工正文，需确认后再提交视频" }];
        review.summary = "人工提示词已保留，但源分镜版本较新，不能把旧正文静默归因于当前分镜";
      }
      return { prompt, promptReview: review, source: "saved", stale, trackVersion: current.version };
    }
  }
  const prepared = await actions.prepare(input);
  const completed = await executeVideoPromptJob(db, prepared.job.id, async (job) => {
    const draft = hooks.generateDraft ? await hooks.generateDraft(job, () => actions.generateDraft(job)) : await actions.generateDraft(job);
    return hooks.reviewDraft ? hooks.reviewDraft(job, draft, () => actions.reviewDraft(job, draft)) : actions.reviewDraft(job, draft);
  });
  if (completed.state !== "succeeded" || !completed.resultPrompt) throw new VideoPromptJobError("CONFLICT", completed.reason ?? "视频提示词生成未完成");
  const current = await currentTrack(db, input);
  return { prompt: completed.resultPrompt, promptReview: completed.promptReview ?? await preflightVideoPrompt(db, { projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, prompt: completed.resultPrompt, model: input.model, mode: input.mode, generation: input.generation ?? {}, info: input.info }), source: "generated", stale: false, trackVersion: current.version, promptJobId: completed.id };
}
