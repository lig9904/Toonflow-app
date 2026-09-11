import { preflightVideoPrompt } from "@/services/videoPromptReview";
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
import { captureVideoModeSelectionSnapshot, resolveStoredVideoMode, revalidateVideoModeSelection } from "@/services/videoModeResolution";

const ref = z.object({ id: z.number().int().positive(), sources: z.enum(["assets", "storyboard"]), fileType: z.enum(["image", "video", "audio"]).optional(), purpose: z.enum(["first_frame", "last_frame", "identity_reference", "style_reference", "motion_reference", "audio_reference"]).optional() }).strict();
const schema = z.object({
  projectId: z.number().int().positive(), scriptId: z.number().int().positive(), trackId: z.number().int().positive(),
  prompt: z.string(), model: z.string().min(1), mode: z.union([z.string(), z.array(z.unknown())]).optional(), modeIntentRevision: z.number().int().nonnegative().optional(), resolution: z.string(),
  duration: z.number().finite().positive(), audio: z.boolean().optional(), references: z.array(ref).max(100).optional(), uploadData: z.array(ref).max(100).optional(),
  idempotencyKey: z.string().min(8).max(200),
}).strict().superRefine((value, ctx) => { if (value.references === undefined && value.uploadData === undefined) ctx.addIssue({ code: "custom", message: "缺少视频参考素材快照" }); if (value.references !== undefined && value.uploadData !== undefined) ctx.addIssue({ code: "custom", message: "references 与 uploadData 不能同时提供" }); });

export default express.Router().post("/", async (req, res) => {
  try {
    const input = schema.parse(req.body);
    await requireProductionOwner(req, input.projectId, u.db);
    let provider;
    try { provider = await getPersistentVideoTaskProvider(input.model as `${string}:${string}`); }
    catch (error) { throw new VideoJobError("UNSUPPORTED_PROVIDER", error instanceof Error ? error.message : String(error)); }
    const rawReferences = input.references ?? input.uploadData ?? [];
    const modeResolution = await resolveStoredVideoMode(u.db, { projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, model: input.model,
      capabilities: await getConfiguredMediaModel(input.model, "video"), references: rawReferences, expectedIntentRevision: input.modeIntentRevision, legacyMode: input.mode });
    const modeSnapshot = input.modeIntentRevision !== undefined ? await captureVideoModeSelectionSnapshot(u.db, { projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, resolution: modeResolution }, (path) => u.oss.getImageBase64(path)) : undefined;
    const references = await loadOwnedVideoReferences(u.db, input.projectId, input.scriptId, modeResolution.resolvedReferences, (path) => u.oss.getImageBase64(path), videoReferenceOptionsForProvider(provider, u.getPath("oss"), input.model));
    if (modeSnapshot) await revalidateVideoModeSelection(u.db, { projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, snapshot: modeSnapshot }, (path) => u.oss.getImageBase64(path));
    const project = await u.db("o_project").where({ id: input.projectId }).select("videoRatio").first();
    const config = { prompt: input.prompt, referenceList: references, mode: parseVideoMode(modeResolution.resolvedMode), duration: input.duration,
      ...(modeSnapshot ? { toonflowModeSelection: modeSnapshot } : {}),
      aspectRatio: (project?.videoRatio as "16:9" | "9:16") || "16:9", resolution: input.resolution, audio: input.audio };
    const jobs = getRuntimeVideoJobService();
    const requestHash = hashVideoJobRequest({ modelKey: input.model, providerFingerprint: provider.fingerprint, projectId: input.projectId,
      scriptId: input.scriptId, trackId: input.trackId, config });
    const existing = await jobs.findByIdempotency(input.projectId, input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== requestHash) throw new VideoJobError("CONFLICT", "idempotencyKey 已用于不同的视频任务参数");
      return res.send(success({ videoId: existing.videoId, jobId: existing.id, status: existing.status, reused: true, modeResolution }));
    }
    const promptReview = await preflightVideoPrompt(u.db, { projectId: input.projectId, scriptId: input.scriptId, trackId: input.trackId, prompt: input.prompt, model: input.model, mode: modeResolution.resolvedMode, generation: { duration: input.duration, resolution: input.resolution, audio: input.audio ?? false }, info: modeResolution.resolvedReferences, referenceTypes: references.map((item) => item.type) });
    const request: VideoJobRequest = { modelKey: input.model, providerFingerprint: provider.fingerprint, projectId: input.projectId,
      scriptId: input.scriptId, trackId: input.trackId, outputPath: `/${input.projectId}/video/${uuid()}.mp4`, config };
    const reserved = await jobs.reserveNewVideo(input.idempotencyKey, request, requestHash);
    res.send(success({ videoId: reserved.job.videoId, jobId: reserved.job.id, status: reserved.job.status, reused: !reserved.created, promptReview, modeResolution }));
    if (reserved.created) void jobs.submitReserved(reserved.job.id).catch((error) => console.error("[videoJobs] submit failed", error));
  } catch (error) {
    sendProductionError(res, error);
  }
});
