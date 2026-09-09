import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { success } from "@/lib/responseFormat";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { getPersistentVideoTaskProvider } from "@/utils/ai";
import { hashVideoJobRequest, VideoJobError, type VideoJobRequest } from "@/services/videoJobs";
import { getRuntimeVideoJobService } from "@/services/videoJobs/runtime";
import { loadOwnedVideoReferences, parseVideoMode } from "@/services/videoJobs/request";

const ref = z.object({ id: z.number().int().positive(), sources: z.enum(["assets", "storyboard"]), fileType: z.enum(["image", "video", "audio"]).optional() });
const schema = z.object({
  projectId: z.number().int().positive(), scriptId: z.number().int().positive(), trackId: z.number().int().positive(),
  prompt: z.string(), model: z.string().min(1), mode: z.union([z.string(), z.array(z.unknown())]), resolution: z.string(),
  duration: z.number().finite().positive(), audio: z.boolean().optional(), uploadData: z.array(ref),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export default express.Router().post("/", async (req, res) => {
  try {
    const input = schema.parse(req.body);
    await requireProductionOwner(req, input.projectId, u.db);
    const references = await loadOwnedVideoReferences(u.db, input.projectId, input.scriptId, input.uploadData, (path) => u.oss.getImageBase64(path));
    const project = await u.db("o_project").where({ id: input.projectId }).select("videoRatio").first();
    let provider;
    try { provider = await getPersistentVideoTaskProvider(input.model as `${string}:${string}`); }
    catch (error) { throw new VideoJobError("UNSUPPORTED_PROVIDER", error instanceof Error ? error.message : String(error)); }
    const config = { prompt: input.prompt, referenceList: references, mode: parseVideoMode(input.mode), duration: input.duration,
      aspectRatio: (project?.videoRatio as "16:9" | "9:16") || "16:9", resolution: input.resolution, audio: input.audio };
    const jobs = getRuntimeVideoJobService();
    const requestHash = hashVideoJobRequest({ modelKey: input.model, providerFingerprint: provider.fingerprint, projectId: input.projectId,
      scriptId: input.scriptId, trackId: input.trackId, config });
    const existing = await jobs.findByIdempotency(input.projectId, input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== requestHash) throw new VideoJobError("CONFLICT", "idempotencyKey 已用于不同的视频任务参数");
      return res.send(success({ videoId: existing.videoId, jobId: existing.id, status: existing.status, reused: true }));
    }
    const request: VideoJobRequest = { modelKey: input.model, providerFingerprint: provider.fingerprint, projectId: input.projectId,
      scriptId: input.scriptId, trackId: input.trackId, outputPath: `/${input.projectId}/video/${uuid()}.mp4`, config };
    const reserved = await jobs.reserveNewVideo(input.idempotencyKey, request, requestHash);
    res.send(success({ videoId: reserved.job.videoId, jobId: reserved.job.id, status: reserved.job.status, reused: !reserved.created }));
    if (reserved.created) void jobs.submitReserved(reserved.job.id).catch((error) => console.error("[videoJobs] submit failed", error));
  } catch (error) {
    sendProductionError(res, error);
  }
});
