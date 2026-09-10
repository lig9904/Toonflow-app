import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ensureVideoPromptJobSchema } from "@/services/videoPromptJobs";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackIds: z.array(z.number()),
    jobIds: z.array(z.string()).optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, trackIds, jobIds = [] } = req.body;
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
    const promptList = tracks.map((track) => {
      const job = jobsByTrack.get(Number(track.id));
      return job
        ? { id: Number(track.id), jobId: String(job.id), state: state(String(job.state)), reason: job.reason ?? "", prompt: job.resultPrompt ?? track.prompt ?? "", version: versionByTrack.get(Number(track.id)) ?? 0 }
        : { ...track, version: versionByTrack.get(Number(track.id)) ?? 0 };
    });
    res.status(200).send(success(promptList));
  },
);
