import {readRoleVoiceCasting} from "./roleAudioWorkspace";
import { classifyImageFinding, videoPreflightVerdict, videoSettingsIssues, type VideoPreflightTarget } from "../lib/videoPreflightContract";
import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { dialogueFindings, speakerFindings, referenceLabelFindings, type VideoPromptFinding, type VideoPromptReviewReport } from "../lib/videoPromptContract";
import { buildStoryboardVideoPrompt } from "../lib/storyboardVisualContract";
import { VideoJobError } from "./videoJobs";
import type { VideoPromptJob } from "./videoPromptJobs";
import { parsePromptMode, validatePromptReferenceSelection, type VideoGenerationSettings } from "./videoPromptComposition";
import { classifyVideoPromptReviewFailure } from "./videoPromptReviewRuntime";
import { readCurrentImageReviewResults, type CurrentImageReviewResult } from "./imageReviews";
import { isVolcengineTrustedModel, readPromptTrustedBindings } from "./volcengineReferenceRuntime";
import { readVideoModeIntent } from "./videoModeResolution";

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
  return [...job.sourceSnapshot.flatMap(shot => { const source=buildStoryboardVideoPrompt([shot]); return [...dialogueFindings(source,prompt,names),...speakerFindings(source,prompt,names)].map(finding=>({...finding,shotId:shot.id})); }), ...referenceLabelFindings(prompt, job.referenceLabels ?? [])];
}
function preservesExplicitIntent(job: VideoPromptJob, draft: string, candidate: string): boolean {
  const source = buildStoryboardVideoPrompt(job.sourceSnapshot);
  const assets = (job.referenceSnapshot as any)?.linkedAssets ?? [];
  const terms: string[] = assets.map((asset: any) => String(asset.name ?? "")).filter(Boolean);
  for (const term of source.match(/非人类|人类儿童|儿童|成年人|幼态|神兽|机甲|倒影|镜像|记忆同框|配乐|光影|月光|(?:[一二三四五六七八九十百零两]+|\d+)岁/gu) ?? []) terms.push(term);
  return terms.every((term) => !draft.includes(term) || candidate.includes(term));
}

/** One text-only review, with at most one returned minimal correction. No media calls or retries. */
export async function reviewGeneratedVideoPrompt(job: VideoPromptJob, draft: string, model: VideoPromptReviewModel, onCandidate?: (text:string)=>Promise<void>): Promise<{ prompt: string; review: VideoPromptReviewReport }> {
  const deterministic = deterministicPromptFindings(job, draft);
  const reviewedAt = Date.now();
  if (!job.compositionSnapshot) return { prompt: draft, review: { status: "skipped", findings: deterministic, summary: "旧任务未保存复核模板快照，仅执行确定性检查", revised: false, reviewedAt } };
  try {
    const response = videoPromptReviewSchema.parse(await model({ system: `${job.compositionSnapshot.reviewSystem}\n执行协议：按 schema 返回 findings、summary 和可选 correctedPrompt。只对有源证据的具体错误给最小修正，保留原文对白、说话人、身份与当前人工创作要求；审美不确定项用 warning/info。不得调用工具或生成媒体。`, input: { context: job.compositionSnapshot.context, source: job.sourceSnapshot, references: job.referenceSnapshot, referenceLabels: job.referenceLabels, prompt: draft, deterministicFindings: deterministic }, schema: videoPromptReviewSchema }));
    let prompt = draft;
    let revised = false;
    // Never accept a cosmetic rewrite, and require all deterministic content checks after correction.
    const candidate = response.correctedPrompt?.trim();
    if(candidate)await onCandidate?.(candidate);
    if (candidate && candidate !== draft && (deterministic.length || response.findings.some((finding) => finding.severity === "error")) && deterministicPromptFindings(job, candidate).length === 0 && preservesExplicitIntent(job, draft, candidate)) { prompt = candidate; revised = true; }
    const findings = [...deterministicPromptFindings(job, prompt), ...response.findings.map((finding) => ({ ...finding, ...(revised ? { message: `原稿发现（已应用一次最小修正，修正后待语义复核）：${finding.message}` } : {}) }))];
    return { prompt, review: { status: findings.length ? "issues" : "passed", findings, summary: revised ? `${response.summary} 已应用一次最小修正；原发现保留，修正效果未经再次语义复核。` : response.summary, revised, reviewedAt } };
  } catch (error) {
    const failure = classifyVideoPromptReviewFailure(error);
    return { prompt: draft, review: { status: "failed", findings: [...deterministic, { code: "SEMANTIC_REVIEW_FAILED", severity: "warning", message: `语义复核未完成（${failure.code}），已保留提示词；不会自动重试或触发媒体生成` }], summary: "语义复核失败，确定性检查仍有效", revised: false, reviewedAt, failure } };
  }
}
const json = (value: any) => typeof value === "string" ? JSON.parse(value) : value;

/** Refresh the same authoritative identity/reference shape captured by prompt preparation. */
export async function currentPromptReferences(db: Knex, projectId: number, scriptId: number, source: Array<{ id: number }>, saved: any, trackId?: number): Promise<any> {
  const info = saved?.info ?? [];
  const storyboardIds = info.filter((item: any) => item.sources === "storyboard").map((item: any) => Number(item.id));
  const assetIds = info.filter((item: any) => item.sources === "assets").map((item: any) => Number(item.id));
  const storyboards = storyboardIds.length ? await db("o_storyboard").where({ projectId, scriptId }).whereIn("id", storyboardIds).select("id", "prompt", "videoDesc", "duration", "trackId", "filePath") : [];
  const assets = assetIds.length ? await db("o_assets as asset").leftJoin("o_image as image", "image.id", "asset.imageId").where("asset.projectId", projectId).whereIn("asset.id", assetIds).select("asset.id", "asset.name", "asset.describe", "asset.type", "asset.imageId", "image.filePath", "image.type as mediaType") : [];
  const linkedAssets = source.length ? await db("o_assets2Storyboard as link").join("o_assets as asset", "asset.id", "link.assetId").where("asset.projectId", projectId).whereIn("link.storyboardId", source.map((item) => Number(item.id))).orderBy("link.id").select("asset.id", "asset.name", "asset.describe", "asset.type", "asset.imageId") : [];
  const referencedAssetIds = [...new Set([...assetIds, ...linkedAssets.map((row) => Number(row.id))])];
  const [storyboardStates, assetStates] = await Promise.all([
    storyboardIds.length ? db("ext_entity_state").where({ projectId, entityType: "storyboard" }).whereIn("entityId", storyboardIds).select("entityId", "version") : [],
    referencedAssetIds.length ? db("ext_creative_state").where({ projectId, entityType: "asset" }).whereIn("entityId", referencedAssetIds).select("entityId", "version") : [],
  ]);
  const withVersion = (entityType: "storyboard" | "asset", row: any) => ({ ...row, version: Number((entityType === "storyboard" ? storyboardStates : assetStates).find((state) => Number(state.entityId) === Number(row.id))?.version ?? 0) });
  const trustedAssets = Object.hasOwn(saved ?? {}, "trustedAssets") ? await readPromptTrustedBindings(db, projectId, scriptId, info) : undefined;
  const modeIntent = saved?.modeIntent && Number.isSafeInteger(trackId) && Number(trackId) > 0 ? await readVideoModeIntent(db, { projectId, scriptId, trackId: Number(trackId) }).catch(() => null) : null;
  const voiceCasting=Object.hasOwn(saved ?? {},"voiceCasting")?await readRoleVoiceCasting(db,projectId,linkedAssets.filter(row=>row.type==="role").map(row=>Number(row.id))):undefined;
  return { ...(voiceCasting ? {voiceCasting} : {}), info, selectedStoryboards: info.filter((item: any) => item.sources === "storyboard").map((item: any) => storyboards.find((row) => Number(row.id) === Number(item.id))).filter(Boolean).map((row: any) => withVersion("storyboard", row)), selectedAssets: info.filter((item: any) => item.sources === "assets").map((item: any) => assets.find((row) => Number(row.id) === Number(item.id))).filter(Boolean).map((row: any) => withVersion("asset", row)), linkedAssets: linkedAssets.map((row) => withVersion("asset", row)), ...(modeIntent ? { modeIntent: { modeIntent: modeIntent.modeIntent, revision: modeIntent.revision } } : {}), ...(trustedAssets ? { trustedAssets } : {}) };
}

export async function readCurrentVideoPromptReview(db: Knex, input: { projectId: number; scriptId: number; trackId: number; prompt: string; model?: string; mode?: unknown; generation?: VideoGenerationSettings; info?: Array<{ id: number; sources: string; fileType?: string }> }): Promise<VideoPromptReviewReport | null> {
  if (!(await db.schema.hasTable("ext_video_prompt_jobs")) || !(await db.schema.hasColumn("ext_video_prompt_jobs", "reviewReport"))) return null;
  const jobs = await db("ext_video_prompt_jobs").where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, state: "succeeded", resultPrompt: input.prompt }).whereNotNull("reviewReport").orderBy("createdAt", "desc").limit(10);
  const sourceRows = await db("o_storyboard").where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId }).orderBy("index").orderBy("id").select("id", "prompt", "videoDesc", "duration");
  const sourceStates = sourceRows.length ? await db("ext_entity_state").where({ projectId: input.projectId, entityType: "storyboard" }).whereIn("entityId", sourceRows.map((row) => Number(row.id))).select("entityId", "version") : [];
  const source = sourceRows.map((row) => ({ ...row, version: Number(sourceStates.find((state) => Number(state.entityId) === Number(row.id))?.version ?? 0) }));
  for (const row of jobs) {
    const compositionSnapshot = json(row.compositionSnapshot);
    const referenceSnapshot = json(row.referenceSnapshot);
    if (input.model !== undefined && input.model !== row.model) continue;
    if (input.mode !== undefined && videoPromptReviewHash(parsePromptMode(input.mode)) !== videoPromptReviewHash(parsePromptMode(row.mode))) continue;
    if (input.generation !== undefined && videoPromptReviewHash(input.generation) !== videoPromptReviewHash(compositionSnapshot?.context.generation)) continue;
    const normalizeInfo = (items: any[]) => items.map((item) => ({ id: Number(item.id), sources: item.sources, fileType: item.fileType ?? "image", purpose: item.purpose ?? null }));
    if (input.info !== undefined && videoPromptReviewHash(normalizeInfo(input.info)) !== videoPromptReviewHash(normalizeInfo(referenceSnapshot?.info ?? []))) continue;
    const currentReferences = await currentPromptReferences(db, input.projectId, input.scriptId, source, { ...referenceSnapshot, ...(isVolcengineTrustedModel(row.model) ? { trustedAssets: referenceSnapshot?.trustedAssets ?? [] } : {}) }, input.trackId);
    if (row.reviewBinding === promptReviewBinding({ sourceSnapshot: source, referenceSnapshot: currentReferences, compositionSnapshot, model: row.model, mode: row.mode }, input.prompt)) return json(row.reviewReport);
  }
  return null;
}

function imageReviewBoundaryFinding(item: CurrentImageReviewResult, target: VideoPreflightTarget): VideoPromptFinding[] {
  const label = `${target.shotLabel ? target.shotLabel + " · " : ""}${target.referenceLabel}${target.purpose === "first_frame" ? "（首帧）" : target.purpose === "last_frame" ? "（尾帧）" : ""}`;
  if (item.state === "passed") return [];
  if (item.state === "issues" && item.review) return item.review.findings.map((finding) => ({ ...classifyImageFinding(finding, target.purpose), target, code: `IMAGE_REFERENCE_${finding.code}`, field: "references", message: `${label}：${finding.message}`, suggestion: /FRAMING|SHOT_SIZE/.test(finding.code) ? "按镜头开始状态重新生成首帧；仅当原图有足够局部细节时使用裁切" : "对照当前镜头要求检查这张参考图" }));
  const boundary = {
    pending: ["info", "图片核验仍在进行；本次没有等待或自动重画"],
    stale: ["warning", "现有图片核验与当前选中图片或其来源版本不匹配"],
    failed: ["warning", "图片核验未完成；当前图片保持不变"],
    unreviewed: ["info", "当前选中图片尚无核验结果"],
    missing: ["warning", "当前参考对象没有已选中的图片"],
    issues: ["warning", "图片核验发现需要关注的问题"],
  }[item.state] as ["info" | "warning", string] | undefined;
  return boundary ? [{ code: `IMAGE_REFERENCE_${item.state.toUpperCase()}`, severity: boundary[0], target, field: "references", message: `参考图片 ${label}：${boundary[1]}` }] : [];
}

async function currentImageReferenceFindings(db: Knex, input: { projectId: number; scriptId: number; model?: string; info: Array<{ id: number; sources: string; fileType?: string; purpose?: string }>; referenceTypes?: Array<"image" | "video" | "audio"> }): Promise<VideoPromptFinding[]> {
  const trusted = isVolcengineTrustedModel(input.model) ? await readPromptTrustedBindings(db, input.projectId, input.scriptId, input.info) : [];
  const imageInputs = input.info.filter((item, index) => (input.referenceTypes?.[index] ?? item.fileType ?? "image") === "image" && !trusted.some((entry) => entry.inputIndex === index));
  const storyboardIds = [...new Set(imageInputs.filter((item) => item.sources === "storyboard").map((item) => Number(item.id)))];
  const assetIds = [...new Set(imageInputs.filter((item) => item.sources === "assets").map((item) => Number(item.id)))];
  const [storyboards, assets] = await Promise.all([
    storyboardIds.length ? readCurrentImageReviewResults(db, { projectId: input.projectId, scriptId: input.scriptId, targetKind: "storyboard", targetIds: storyboardIds }).catch(() => []) : [],
    assetIds.length ? readCurrentImageReviewResults(db, { projectId: input.projectId, scriptId: input.scriptId, targetKind: "asset", targetIds: assetIds }).catch(() => []) : [],
  ]);
  const indexes = storyboardIds.length ? await db("o_storyboard").where({projectId:input.projectId,scriptId:input.scriptId}).whereIn("id",storyboardIds).select("id","index","prompt") : [];
  let imageIndex=0;
  const findings:VideoPromptFinding[]=[];
  input.info.forEach((ref,index)=>{
    if((input.referenceTypes?.[index] ?? ref.fileType ?? "image")!=="image")return;
    imageIndex++;
    if(trusted.some(entry=>entry.inputIndex===index))return;
    const item=[...storyboards,...assets].find(row=>Number(row.targetId)===Number(ref.id)&&row.targetKind===(ref.sources==="storyboard"?"storyboard":"asset"));
    if(!item)return;
    const shot=ref.sources==="storyboard"?indexes.find(row=>Number(row.id)===Number(ref.id)):undefined;
    const target:VideoPreflightTarget={kind:ref.sources==="storyboard"?"storyboard":"asset",id:Number(ref.id),referenceIndex:index,referenceLabel:`图片${imageIndex}`,purpose:ref.purpose,shotLabel:shot?`S${String(Number(shot.index)+1).padStart(2,"0")}`:undefined,artifactPath:item.artifactPath,artifactHash:item.artifactHash,reviewId:item.review?.id};
    findings.push(...imageReviewBoundaryFinding(item,target).map(f=>({...f,expected:shot?.prompt})));
  });
  return findings.concat(trusted.map((entry) => ({ code: "VOLCENGINE_TRUSTED_REFERENCE", severity: "info" as const, field: "references", message: `引用已绑定的火山素材 ${entry.assetId}；本地图片核验结果不代表云端素材已核验，提交前会重新检查素材可用状态` })));
}

/** Pre-submission is read-only and never rewrites a manually edited prompt or calls a paid model. */
export async function preflightVideoPrompt(db: Knex, input: { projectId: number; scriptId: number; trackId: number; prompt: string; model: string; mode: unknown; generation: VideoGenerationSettings; info: Array<{ id: number; sources: string; fileType?: string; purpose?: string }>; referenceTypes?: Array<"image" | "video" | "audio">; collectOnly?: boolean; acknowledgement?: string; referenceBinding?: unknown; capabilities?: unknown }): Promise<VideoPromptReviewReport> {
  const source = await db("o_storyboard").where({ projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId }).orderBy("index").orderBy("id").select("id", "prompt", "videoDesc", "duration");
  const references = await currentPromptReferences(db, input.projectId, input.scriptId, source, { voiceCasting: [], info: input.info, ...(isVolcengineTrustedModel(input.model) ? { trustedAssets: [] } : {}) });
  const counts = { image: 0, video: 0, audio: 0 };
  const labels = input.info.map((item, index) => { const type = input.referenceTypes?.[index] ?? item.fileType ?? "image"; if (!(type in counts)) throw new VideoJobError("INVALID_INPUT", "参考媒体类型无效"); const media = type as keyof typeof counts; return `@${{ image: "图片", video: "视频", audio: "音频" }[media]}${++counts[media]}`; });
  const findings = [...deterministicPromptFindings({ sourceSnapshot: source, referenceSnapshot: references, referenceLabels: labels }, input.prompt), ...await currentImageReferenceFindings(db, input)];
  if(input.model.startsWith("volcengineSd2:") && input.generation.audio){
    const casting=references.voiceCasting ?? [];
    const roles=(references.linkedAssets ?? []).filter((a:any)=>a.type==="role");
    for(const role of [...new Map(roles.map((r:any)=>[Number(r.id),r])).values()] as any[]){
      const voice=casting.find((v:any)=>v.roleAssetId===Number(role.id));
      const index=voice?input.info.findIndex(i=>i.sources==="assets" && Number(i.id)===voice.audioId):-1;
      if(index<0)findings.push({code:"VOICE_REFERENCE_MISSING",severity:"warning",field:"references",message:`${role.name}：${voice?"已绑定的固定声音未加入本次参考，可重新载入片段参考后核对提示词":"尚未绑定固定声音参考；如本镜有该角色对白，跨片段音色可能变化"}`,suggestion:"在角色素材中选择固定声音片段；已有片段可重新载入参考。无对白角色可忽略此项。"});
      else if(!input.prompt.includes(labels[index]))findings.push({code:"VOICE_CASTING_UNCLEAR",severity:"warning",field:"prompt",message:`${role.name} 的声音参考 ${labels[index]} 已加入，但提示词未明确引用`,suggestion:`在提示词中说明该角色音色参考 ${labels[index]}，保存后再生成；不复制参考音频原台词。`});
    }
  }
  if (!input.prompt.trim()) findings.push({code:"PROMPT_EMPTY",severity:"error",field:"prompt",message:"视频提示词不能为空",overridable:false,suggestion:"生成或手动填写提示词后保存"});
  findings.push(...videoSettingsIssues(input.capabilities,input.generation));
  const scriptDuration=source.reduce((sum,row)=>sum+(Number(row.duration)||0),0);
  if(typeof input.generation.duration==="number"&&input.generation.duration<scriptDuration)findings.push({code:"SOURCE_DURATION_EXCEEDS_GENERATION",severity:"error",field:"duration",overridable:false,message:`脚本 ${scriptDuration} 秒，当前生成时长 ${input.generation.duration} 秒不足以覆盖本镜头`,suggestion:"选择支持的更长时长，或先在画布明确拆分镜头"});
  try { validatePromptReferenceSelection(input.mode, [...Array(counts.image).fill("image"), ...Array(counts.video).fill("video"), ...Array(counts.audio).fill("audio")]); }
  catch (error) { findings.push({code:"REFERENCE_MODE_INVALID",severity:"error",field:"references",message:error instanceof Error ? error.message : "参考模式无效",overridable:false}); }

  const saved = await readCurrentVideoPromptReview(db, input);
  const row = await db("o_storyboard").where({projectId:input.projectId,scriptId:input.scriptId,trackId:input.trackId}).orderBy("index").first("index");
  const shotLabel=row?`S${String(Number(row.index)+1).padStart(2,"0")}`:`自建片段 T${input.trackId}`;
  const preflight=videoPreflightVerdict({trackId:input.trackId,shotLabel,issues:findings,acknowledgement:input.acknowledgement,binding:{projectId:input.projectId,scriptId:input.scriptId,trackId:input.trackId,prompt:input.prompt,source,references,model:input.model,mode:input.mode,generation:input.generation,referenceBinding:input.referenceBinding}});
  const report:VideoPromptReviewReport=saved?{...saved,preflight,findings:[...saved.findings,...findings.filter(item=>!saved.findings.some(existing=>existing.code===item.code&&existing.message===item.message))]}:{preflight,status:findings.length?"issues":"skipped",findings,summary:"已检查当前提示词、参考图片和生成输入；未重新调用模型",revised:false,reviewedAt:Date.now()};
  if(!preflight.canSubmit&&!input.collectOnly)throw new VideoPreflightError(report);
  return report;
}

export class VideoPreflightError extends VideoJobError {
  constructor(public readonly report:VideoPromptReviewReport){super("INVALID_INPUT",`${report.preflight?.shotLabel ?? "当前片段"}有${report.preflight?.issues.filter(i=>i.severity==="error").length ?? 1}项生成前问题，视频尚未提交`);}
}
