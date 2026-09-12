import { preflightVideoPrompt, VideoPreflightError } from "@/services/videoPromptReview";
import type { VideoPromptReviewReport } from "@/lib/videoPromptContract";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { success } from "@/lib/responseFormat";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { getConfiguredMediaModel, getPersistentVideoTaskProvider } from "@/utils/ai";
import { hashVideoJobRequest, VideoJobError, type VideoJobRequest } from "@/services/videoJobs";
import { getRuntimeVideoJobService } from "@/services/videoJobs/runtime";
import { loadOwnedVideoReferences, parseVideoMode, videoReferenceOptionsForProvider } from "@/services/videoJobs/request";
import { captureVideoModeSelectionSnapshot, resolveStoredVideoMode, revalidateVideoModeSelection, type VideoModeResolution } from "@/services/videoModeResolution";

const ref = z.object({ id: z.number().int().positive(), sources: z.enum(["assets", "storyboard"]), fileType: z.enum(["image", "video", "audio"]).optional(), purpose: z.enum(["first_frame", "last_frame", "identity_reference", "style_reference", "motion_reference", "audio_reference"]).optional() }).strict();
const track = z.object({ trackId: z.number().int().positive(), prompt: z.string(), duration: z.number().finite().positive(),
  references: z.array(ref).max(100).optional(), uploadData: z.array(ref).max(100).optional(), modeIntentRevision: z.number().int().nonnegative().optional(), acknowledgement: z.string().regex(/^[a-f0-9]{64}$/).optional(), idempotencyKey: z.string().min(8).max(200) }).strict().superRefine((value, ctx) => { if (value.references === undefined && value.uploadData === undefined) ctx.addIssue({ code: "custom", message: "缺少视频参考素材快照" }); if (value.references !== undefined && value.uploadData !== undefined) ctx.addIssue({ code: "custom", message: "references 与 uploadData 不能同时提供" }); });
const schema = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(), trackData: z.array(track).min(1).max(20),
  model: z.string().min(1), mode: z.union([z.string(), z.array(z.unknown())]).optional(), resolution: z.string(), audio: z.boolean().optional() }).strict();

export default express.Router().post("/", async (req, res) => {
  try {
    const input = schema.parse(req.body);
    await requireProductionOwner(req, input.projectId, u.db);
    let provider;
    try { provider = await getPersistentVideoTaskProvider(input.model as `${string}:${string}`); }
    catch (error) { throw new VideoJobError("UNSUPPORTED_PROVIDER", error instanceof Error ? error.message : String(error)); }
    const project = await u.db("o_project").where({ id: input.projectId }).select("videoRatio").first();
    const capabilities = await getConfiguredMediaModel(input.model, "video");
    const jobs = getRuntimeVideoJobService();
    const promptReviews = new Map<number, VideoPromptReviewReport>();
    const modeResolutions = new Map<number, VideoModeResolution>();
    const reservations: Array<{ idempotencyKey: string; request: VideoJobRequest; requestHash: string }> = [];
    const preflightFailures:VideoPromptReviewReport[]=[];
    for (const item of input.trackData) {
      try {
      const modeResolution = await resolveStoredVideoMode(u.db, { projectId: input.projectId, scriptId: input.scriptId, trackId: item.trackId, model: input.model, capabilities,
        references: item.references ?? item.uploadData ?? [], expectedIntentRevision: item.modeIntentRevision, legacyMode: input.mode });
      modeResolutions.set(item.trackId, modeResolution);
      const modeSnapshot = item.modeIntentRevision !== undefined ? await captureVideoModeSelectionSnapshot(u.db, { projectId: input.projectId, scriptId: input.scriptId, trackId: item.trackId, resolution: modeResolution }, (path) => u.oss.getImageBase64(path)) : undefined;
      const references = await loadOwnedVideoReferences(u.db, input.projectId, input.scriptId, modeResolution.resolvedReferences, (path) => u.oss.getImageBase64(path), videoReferenceOptionsForProvider(provider, u.getPath("oss"), input.model));
      if (modeSnapshot) await revalidateVideoModeSelection(u.db, { projectId: input.projectId, scriptId: input.scriptId, trackId: item.trackId, snapshot: modeSnapshot }, (path) => u.oss.getImageBase64(path));
      const config = { prompt: item.prompt, referenceList: references, mode: parseVideoMode(modeResolution.resolvedMode), duration: item.duration,
        ...(modeSnapshot ? { toonflowModeSelection: modeSnapshot } : {}),
        ...( item.acknowledgement ? { toonflowPreflightAcknowledgement: item.acknowledgement } : {}),
      aspectRatio: (project?.videoRatio as "16:9" | "9:16") || "16:9", resolution: input.resolution, audio: input.audio };
      const requestHash = hashVideoJobRequest({ modelKey: input.model, providerFingerprint: provider.fingerprint, projectId: input.projectId,
        scriptId: input.scriptId, trackId: item.trackId, config });
      const existing = await jobs.findByIdempotency(input.projectId, item.idempotencyKey);
      if (existing && existing.payloadHash !== requestHash) throw new VideoJobError("CONFLICT", "idempotencyKey 已用于不同的视频任务参数");
      if (!existing) promptReviews.set(item.trackId, await preflightVideoPrompt(u.db, { projectId: input.projectId, scriptId: input.scriptId, trackId: item.trackId, prompt: item.prompt, model: input.model, mode: modeResolution.resolvedMode, generation: { duration: item.duration, resolution: input.resolution, audio: input.audio ?? false }, capabilities, acknowledgement: item.acknowledgement, referenceBinding: modeSnapshot, info: modeResolution.resolvedReferences, referenceTypes: references.map((reference) => reference.type) }));
      reservations.push({ idempotencyKey: item.idempotencyKey, request: { modelKey: input.model, providerFingerprint: provider.fingerprint,
        projectId: input.projectId, scriptId: input.scriptId, trackId: item.trackId, outputPath: `/${input.projectId}/video/${uuid()}.mp4`, config }, requestHash });
      } catch(error){if(error instanceof VideoPreflightError)preflightFailures.push(error.report);else throw error;}
    }
    if(preflightFailures.length)return res.status(422).send({code:"VIDEO_PREFLIGHT_BLOCKED",message:`${preflightFailures.length}个片段需要处理，批次尚未提交`,submissionOutcome:"not_submitted",reports:preflightFailures});
    const reserved = await jobs.reserveNewVideos(reservations);
    const results = reserved.map((result) => ({ videoId: result.job.videoId, trackId: result.job.trackId, jobId: result.job.id, status: result.job.status, reused: !result.created, promptReview: promptReviews.get(Number(result.job.trackId)) ?? null, modeResolution: modeResolutions.get(Number(result.job.trackId)) }));
    res.send(success(results));
    for (const result of reserved) if (result.created) void jobs.submitReserved(result.job.id).catch((error) => console.error("[videoJobs] submit failed", error));
  } catch (error) {
    sendProductionError(res, error);
  }
});
