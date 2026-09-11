import { readCurrentVideoPromptReview } from "@/services/videoPromptReview";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ensureVideoPromptJobSchema } from "@/services/videoPromptJobs";
const router = express.Router();
const infoSchema = z.object({ id: z.number().int().positive(), sources: z.enum(["storyboard", "assets"]), fileType: z.enum(["image", "video", "audio"]).optional() });
const reviewInputSchema = z.object({ trackId: z.number().int().positive(), model: z.string().min(1), mode: z.union([z.string(), z.array(z.unknown())]),
  generation: z.object({ duration: z.number().finite().positive().optional(), resolution: z.string().min(1).optional(), audio: z.boolean().optional() }), info: z.array(infoSchema) });

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackIds: z.array(z.number()),
    jobIds: z.array(z.string()).optional(),
    reviewInputs: z.array(reviewInputSchema).optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, trackIds, jobIds = [], reviewInputs = [] } = req.body;
    await ensureVideoPromptJobSchema(u.db);
    const tracks = await u
      .db("o_videoTrack")
      .where("projectId", projectId)
      .where("scriptId", scriptId)
      .whereIn("id", trackIds)
      .select("id", "state", "reason", "prompt");
    const latestJobs = await u.db("ext_video_prompt_jobs").where({ projectId, scriptId }).whereIn("trackId", trackIds).orderBy("createdAt", "desc");
    const versions = await u.db("ext_creative_state").where({ projectId, entityType: "track" }).whereIn("entityId", trackIds).select("entityId", "version");
    const versionByTrack = new Map(versions.map((row) => [Number(row.entityId), Number(row.version)]));
    const selectedJobs = jobIds.length ? latestJobs.filter((job) => jobIds.includes(String(job.id))) : latestJobs;
    const jobsByTrack = new Map<number, any>();
    for (const job of selectedJobs) if (!jobsByTrack.has(Number(job.trackId))) jobsByTrack.set(Number(job.trackId), job);
    const state = (value: string): string => value === "succeeded" ? "已完成" : value === "failed" ? "生成失败" : value === "queued" || value === "running" ? "生成中" : value;
    const promptList = await Promise.all(tracks.map(async (track) => {
      const reviewInput = reviewInputs.find((item: { trackId: number }) => Number(item.trackId) === Number(track.id));
      const promptReview = reviewInput ? await readCurrentVideoPromptReview(u.db, { projectId, scriptId, trackId: Number(track.id), prompt: track.prompt ?? "", model: reviewInput.model, mode: reviewInput.mode, generation: reviewInput.generation, info: reviewInput.info }) : null;
      const job = jobsByTrack.get(Number(track.id));
      return job
        ? { promptReview, id: Number(track.id), jobId: String(job.id), idempotencyKey: String(job.idempotencyKey), state: state(String(job.state)), reason: job.reason ?? "", prompt: track.prompt ?? "", version: versionByTrack.get(Number(track.id)) ?? 0 }
        : { ...track, promptReview, version: versionByTrack.get(Number(track.id)) ?? 0 };
    }));
    res.status(200).send(success(promptList));
  },
);
