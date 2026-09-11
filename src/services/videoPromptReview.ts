import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { dialogueFindings, speakerFindings, referenceLabelFindings, type VideoPromptFinding, type VideoPromptReviewReport } from "../lib/videoPromptContract";
import { buildStoryboardVideoPrompt } from "../lib/storyboardVisualContract";
import { VideoJobError } from "./videoJobs";
import type { VideoPromptJob } from "./videoPromptJobs";
import { parsePromptMode, validatePromptReferenceSelection, type VideoGenerationSettings } from "./videoPromptComposition";

export const videoPromptReviewSchema = z.object({
  findings: z.array(z.object({ code: z.string().min(1).max(100), severity: z.enum(["error", "warning", "info"]), message: z.string().min(1).max(2000), shotId: z.number().int().positive().optional(), field: z.string().max(100).optional() })).max(100),
  summary: z.string().max(2000), correctedPrompt: z.string().max(100000).optional(),
});
export type VideoPromptReviewModel = (input: { system: string; input: unknown; schema: typeof videoPromptReviewSchema }) => Promise<unknown>;
function stable(value: unknown): unknown { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])); return value; }
export function videoPromptReviewHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
export function promptReviewBinding(job: Pick<VideoPromptJob, "sourceSnapshot" | "referenceSnapshot" | "compositionSnapshot" | "model" | "mode">, prompt: string): string {
  return videoPromptReviewHash({ prompt, source: job.sourceSnapshot, references: job.referenceSnapshot, model: job.model, mode: parsePromptMode(job.mode), generation: job.compositionSnapshot?.context.generation });
}
export function deterministicPromptFindings(job: Pick<VideoPromptJob, "sourceSnapshot" | "referenceSnapshot" | "referenceLabels">, prompt: string): VideoPromptFinding[] {
  const assets = (job.referenceSnapshot as any)?.linkedAssets ?? [];
  const names = assets.filter((asset: any) => asset.type === "role").map((asset: any) => String(asset.name ?? ""));
  const source = buildStoryboardVideoPrompt(job.sourceSnapshot);
  return [...dialogueFindings(source, prompt, names), ...speakerFindings(source, prompt, names), ...referenceLabelFindings(prompt, job.referenceLabels ?? [])];
}
function preservesExplicitIntent(job: VideoPromptJob, draft: string, candidate: string): boolean {
  const source = buildStoryboardVideoPrompt(job.sourceSnapshot);
  const assets = (job.referenceSnapshot as any)?.linkedAssets ?? [];
  const terms: string[] = assets.map((asset: any) => String(asset.name ?? "")).filter(Boolean);
  for (const term of source.match(/非人类|人类儿童|儿童|成年人|幼态|神兽|机甲|倒影|镜像|记忆同框|配乐|光影|月光|(?:[一二三四五六七八九十百零两]+|\d+)岁/gu) ?? []) terms.push(term);
  return terms.every((term) => !draft.includes(term) || candidate.includes(term));
}

/** One text-only review, with at most one returned minimal correction. No media calls or retries. */
export async function reviewGeneratedVideoPrompt(job: VideoPromptJob, draft: string, model: VideoPromptReviewModel): Promise<{ prompt: string; review: VideoPromptReviewReport }> {
  const deterministic = deterministicPromptFindings(job, draft);
  const reviewedAt = Date.now();
  if (!job.compositionSnapshot) return { prompt: draft, review: { status: "skipped", findings: deterministic, summary: "旧任务未保存复核模板快照，仅执行确定性检查", revised: false, reviewedAt } };
  try {
    const response = videoPromptReviewSchema.parse(await model({ system: `${job.compositionSnapshot.reviewSystem}\n执行协议：按 schema 返回 findings、summary 和可选 correctedPrompt。只对有源证据的具体错误给最小修正，保留原文对白、说话人、身份与当前人工创作要求；审美不确定项用 warning/info。不得调用工具或生成媒体。`, input: { context: job.compositionSnapshot.context, source: job.sourceSnapshot, references: job.referenceSnapshot, referenceLabels: job.referenceLabels, prompt: draft, deterministicFindings: deterministic }, schema: videoPromptReviewSchema }));
    let prompt = draft;
    let revised = false;
    // Never accept a cosmetic rewrite, and require all deterministic content checks after correction.
    const candidate = response.correctedPrompt?.trim();
    if (candidate && candidate !== draft && (deterministic.length || response.findings.some((finding) => finding.severity === "error")) && deterministicPromptFindings(job, candidate).length === 0 && preservesExplicitIntent(job, draft, candidate)) { prompt = candidate; revised = true; }
    const findings = [...deterministicPromptFindings(job, prompt), ...response.findings.map((finding) => ({ ...finding, ...(revised ? { message: `原稿发现（已应用一次最小修正，修正后待语义复核）：${finding.message}` } : {}) }))];
    return { prompt, review: { status: findings.length ? "issues" : "passed", findings, summary: revised ? `${response.summary} 已应用一次最小修正；原发现保留，修正效果未经再次语义复核。` : response.summary, revised, reviewedAt } };
  } catch {
    return { prompt: draft, review: { status: "failed", findings: [...deterministic, { code: "SEMANTIC_REVIEW_FAILED", severity: "warning", message: "语义复核未完成，已保留提示词；不会自动重试或触发媒体生成" }], summary: "语义复核失败，确定性检查仍有效", revised: false, reviewedAt } };
  }
}
const json = (value: any) => typeof value === "string" ? JSON.parse(value) : value;

/** Refresh the same authoritative identity/reference shape captured by prompt preparation. */
export async function currentPromptReferences(db: Knex, projectId: number, scriptId: number, source: Array<{ id: number }>, saved: any): Promise<any> {
  const info = saved?.info ?? [];
  const storyboardIds = info.filter((item: any) => item.sources === "storyboard").map((item: any) => Number(item.id));
  const assetIds = info.filter((item: any) => item.sources === "assets").map((item: any) => Number(item.id));
  const storyboards = storyboardIds.length ? await db("o_storyboard").where({ projectId, scriptId }).whereIn("id", storyboardIds).select("id", "prompt", "videoDesc", "duration", "trackId", "filePath") : [];
  const assets = assetIds.length ? await db("o_assets as asset").leftJoin("o_image as image", "image.id", "asset.imageId").where("asset.projectId", projectId).whereIn("asset.id", assetIds).select("asset.id", "asset.name", "asset.describe", "asset.type", "asset.imageId", "image.filePath", "image.type as mediaType") : [];
  const linkedAssets = source.length ? await db("o_assets2Storyboard as link").join("o_assets as asset", "asset.id", "link.assetId").where("asset.projectId", projectId).whereIn("link.storyboardId", source.map((item) => Number(item.id))).orderBy("link.id").select("asset.id", "asset.name", "asset.describe", "asset.type", "asset.imageId") : [];
  return { info, selectedStoryboards: info.filter((item: any) => item.sources === "storyboard").map((item: any) => storyboards.find((row) => Number(row.id) === Number(item.id))).filter(Boolean), selectedAssets: info.filter((item: any) => item.sources === "assets").map((item: any) => assets.find((row) => Number(row.id) === Number(item.id))).filter(Boolean), linkedAssets };
}

export async function readCurrentVideoPromptReview(db: Knex, input: { projectId: number; scriptId: number; trackId: number; prompt: string; model?: string; mode?: unknown; generation?: VideoGenerationSettings; info?: Array<{ id: number; sources: string; fileType?: string }> }): Promise<VideoPromptReviewReport | null> {
  if (!(await db.schema.hasTable("ext_video_prompt_jobs")) || !(await db.schema.hasColumn("ext_video_prompt_jobs", "reviewReport"))) return null;
  const jobs = await db("ext_video_prompt_jobs").where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, state: "succeeded", resultPrompt: input.prompt }).whereNotNull("reviewReport").orderBy("createdAt", "desc").limit(10);
  const source = await db("o_storyboard").where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId }).orderBy("index").orderBy("id").select("id", "prompt", "videoDesc", "duration");
  for (const row of jobs) {
    const compositionSnapshot = json(row.compositionSnapshot);
    const referenceSnapshot = json(row.referenceSnapshot);
    if (input.model !== undefined && input.model !== row.model) continue;
    if (input.mode !== undefined && videoPromptReviewHash(parsePromptMode(input.mode)) !== videoPromptReviewHash(parsePromptMode(row.mode))) continue;
    if (input.generation !== undefined && videoPromptReviewHash(input.generation) !== videoPromptReviewHash(compositionSnapshot?.context.generation)) continue;
    const normalizeInfo = (items: any[]) => items.map((item) => ({ id: Number(item.id), sources: item.sources, fileType: item.fileType ?? "image" }));
    if (input.info !== undefined && videoPromptReviewHash(normalizeInfo(input.info)) !== videoPromptReviewHash(normalizeInfo(referenceSnapshot?.info ?? []))) continue;
    const currentReferences = await currentPromptReferences(db, input.projectId, input.scriptId, source, referenceSnapshot);
    if (row.reviewBinding === promptReviewBinding({ sourceSnapshot: source, referenceSnapshot: currentReferences, compositionSnapshot, model: row.model, mode: row.mode }, input.prompt)) return json(row.reviewReport);
  }
  return null;
}

/** Pre-submission is read-only and never rewrites a manually edited prompt or calls a paid model. */
export async function preflightVideoPrompt(db: Knex, input: { projectId: number; scriptId: number; trackId: number; prompt: string; model: string; mode: unknown; generation: VideoGenerationSettings; info: Array<{ id: number; sources: string; fileType?: string }>; referenceTypes?: Array<"image" | "video" | "audio"> }): Promise<VideoPromptReviewReport> {
  const source = await db("o_storyboard").where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId }).orderBy("index").orderBy("id").select("id", "prompt", "videoDesc", "duration");
  const references = await currentPromptReferences(db, input.projectId, input.scriptId, source, { info: input.info });
  const counts = { image: 0, video: 0, audio: 0 };
  const labels = input.info.map((item, index) => { const type = input.referenceTypes?.[index] ?? item.fileType ?? "image"; if (!(type in counts)) throw new VideoJobError("INVALID_INPUT", "参考媒体类型无效"); const media = type as keyof typeof counts; return `@${{ image: "图片", video: "视频", audio: "音频" }[media]}${++counts[media]}`; });
  const findings = deterministicPromptFindings({ sourceSnapshot: source, referenceSnapshot: references, referenceLabels: labels }, input.prompt);
  if (!input.prompt.trim()) throw new VideoJobError("INVALID_INPUT", "视频提示词不能为空");
  try { validatePromptReferenceSelection(input.mode, [...Array(counts.image).fill("image"), ...Array(counts.video).fill("video"), ...Array(counts.audio).fill("audio")]); }
  catch (error) { throw new VideoJobError("INVALID_INPUT", error instanceof Error ? error.message : "参考模式无效"); }
  const invalid = findings.find((finding) => finding.severity === "error");
  if (invalid) throw new VideoJobError("INVALID_INPUT", invalid.message);
  const saved = await readCurrentVideoPromptReview(db, input);
  if (saved) return { ...saved, findings: [...saved.findings, ...findings.filter((item) => !saved.findings.some((existing) => existing.code === item.code && existing.message === item.message))] };
  return { status: findings.length ? "issues" : "skipped", findings, summary: "当前提示词已完成确定性检查；没有与当前正文、源分镜、参考和参数完全匹配的语义复核", revised: false, reviewedAt: Date.now() };
}
