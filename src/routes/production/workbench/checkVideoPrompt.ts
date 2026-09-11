import { readCurrentVideoPromptReview } from "@/services/videoPromptReview";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ensureVideoPromptJobSchema } from "@/services/videoPromptJobs";
const router = express.Router();
const infoSchema = z.object({ id: z.number().int().positive(), sources: z.enum(["storyboard", "assets"]), fileType: z.enum(["image", "video", "audio"]).optional(), purpose: z.enum(["first_frame", "last_frame", "identity_reference", "style_reference", "motion_reference", "audio_reference"]).optional() });
const reviewInputSchema = z.object({ trackId: z.number().int().positive(), model: z.string().min(1), mode: z.union([z.string(), z.array(z.unknown())]).optional(), resolvedMode: z.union([z.string(), z.array(z.unknown())]).optional(), modeIntentRevision: z.number().int().nonnegative().optional(),
  generation: z.object({ duration: z.number().finite().positive().optional(), resolution: z.string().min(1).optional(), audio: z.boolean().optional() }), info: z.array(infoSchema).optional(), references: z.array(infoSchema).optional() }).refine((value) => value.mode !== undefined || value.resolvedMode !== undefined, "缺少已解析视频模式");

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
      const promptReview = reviewInput ? await readCurrentVideoPromptReview(u.db, { projectId, scriptId, trackId: Number(track.id), prompt: track.prompt ?? "", model: reviewInput.model, mode: reviewInput.resolvedMode ?? reviewInput.mode, generation: reviewInput.generation, info: reviewInput.references ?? reviewInput.info ?? [] }) : null;
      const job = jobsByTrack.get(Number(track.id));
      return job
        ? { promptReview, id: Number(track.id), jobId: String(job.id), idempotencyKey: String(job.idempotencyKey), state: state(String(job.state)), reason: job.reason ?? "", prompt: track.prompt ?? "", version: versionByTrack.get(Number(track.id)) ?? 0 }
        : { ...track, promptReview, version: versionByTrack.get(Number(track.id)) ?? 0 };
    }));
    res.status(200).send(success(promptList));
  },
);
