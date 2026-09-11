import { preflightVideoPrompt } from "@/services/videoPromptReview";
import type { VideoPromptReviewReport } from "@/lib/videoPromptContract";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { success } from "@/lib/responseFormat";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { getPersistentVideoTaskProvider } from "@/utils/ai";
import { hashVideoJobRequest, VideoJobError, type VideoJobRequest } from "@/services/videoJobs";
import { getRuntimeVideoJobService } from "@/services/videoJobs/runtime";
import { loadOwnedVideoReferences, parseVideoMode, videoReferenceOptionsForProvider } from "@/services/videoJobs/request";

const ref = z.object({ id: z.number().int().positive(), sources: z.enum(["assets", "storyboard"]), fileType: z.enum(["image", "video", "audio"]).optional() });
const track = z.object({ trackId: z.number().int().positive(), prompt: z.string(), duration: z.number().finite().positive(),
  uploadData: z.array(ref), idempotencyKey: z.string().min(8).max(200) });
const schema = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(), trackData: z.array(track).min(1).max(20),
  model: z.string().min(1), mode: z.union([z.string(), z.array(z.unknown())]), resolution: z.string(), audio: z.boolean().optional() }).strict();

export default express.Router().post("/", async (req, res) => {
  try {
    const input = schema.parse(req.body);
    await requireProductionOwner(req, input.projectId, u.db);
    let provider;
    try { provider = await getPersistentVideoTaskProvider(input.model as `${string}:${string}`); }
    catch (error) { throw new VideoJobError("UNSUPPORTED_PROVIDER", error instanceof Error ? error.message : String(error)); }
    const project = await u.db("o_project").where({ id: input.projectId }).select("videoRatio").first();
    const jobs = getRuntimeVideoJobService();
    const promptReviews = new Map<number, VideoPromptReviewReport>();
    const reservations: Array<{ idempotencyKey: string; request: VideoJobRequest; requestHash: string }> = [];
    for (const item of input.trackData) {
      const references = await loadOwnedVideoReferences(u.db, input.projectId, input.scriptId, item.uploadData, (path) => u.oss.getImageBase64(path), videoReferenceOptionsForProvider(provider, u.getPath("oss")));
      const config = { prompt: item.prompt, referenceList: references, mode: parseVideoMode(input.mode), duration: item.duration,
        aspectRatio: (project?.videoRatio as "16:9" | "9:16") || "16:9", resolution: input.resolution, audio: input.audio };
      const requestHash = hashVideoJobRequest({ modelKey: input.model, providerFingerprint: provider.fingerprint, projectId: input.projectId,
        scriptId: input.scriptId, trackId: item.trackId, config });
      const existing = await jobs.findByIdempotency(input.projectId, item.idempotencyKey);
      if (existing && existing.payloadHash !== requestHash) throw new VideoJobError("CONFLICT", "idempotencyKey 已用于不同的视频任务参数");
      if (!existing) promptReviews.set(item.trackId, await preflightVideoPrompt(u.db, { projectId: input.projectId, scriptId: input.scriptId, trackId: item.trackId, prompt: item.prompt, model: input.model, mode: input.mode, generation: { duration: item.duration, resolution: input.resolution, audio: input.audio ?? false }, info: item.uploadData, referenceTypes: references.map((reference) => reference.type) }));
      reservations.push({ idempotencyKey: item.idempotencyKey, request: { modelKey: input.model, providerFingerprint: provider.fingerprint,
        projectId: input.projectId, scriptId: input.scriptId, trackId: item.trackId, outputPath: `/${input.projectId}/video/${uuid()}.mp4`, config }, requestHash });
    }
    const reserved = await jobs.reserveNewVideos(reservations);
    const results = reserved.map((result) => ({ videoId: result.job.videoId, trackId: result.job.trackId, jobId: result.job.id, status: result.job.status, reused: !result.created, promptReview: promptReviews.get(Number(result.job.trackId)) ?? null }));
    res.send(success(results));
    for (const result of reserved) if (result.created) void jobs.submitReserved(result.job.id).catch((error) => console.error("[videoJobs] submit failed", error));
  } catch (error) {
    sendProductionError(res, error);
  }
});
