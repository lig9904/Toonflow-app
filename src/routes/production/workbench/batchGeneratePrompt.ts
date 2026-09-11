import { prepareRuntimeVideoPromptJob, generateRuntimeVideoPrompt } from "@/services/videoPromptCompositionRuntime";
import express from "express";
import u from "@/utils";
import pLimit from "p-limit";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { executeVideoPromptJob, markVideoPromptPreparationFailed } from "@/services/videoPromptJobs";

const infoSchema = z.object({ id: z.number().int().positive(), sources: z.enum(["storyboard", "assets"]), fileType: z.enum(["image", "video", "audio"]).optional() });
const router = express.Router();
const generationSchema = z.object({ duration: z.number().finite().positive().optional(), resolution: z.string().min(1).optional(), audio: z.boolean().optional() });

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackData: z.array(z.object({ trackId: z.number().int().positive(), info: z.array(infoSchema), idempotencyKey: z.string().min(8).max(150), generation: generationSchema.optional() })).min(1).max(100),
    mode: z.string(),
    model: z.string().min(1),
    concurrentCount: z.number().int().min(1).max(20).optional(),
  }),
  async (req, res) => {
    const { trackData, projectId, scriptId, mode, model, concurrentCount = 5 } = req.body;
    try {
      const projectData = await u.db("o_project").where({ id: projectId }).first();
      if (!projectData) return res.status(400).send(error("项目不存在"));
      const limit = pLimit(concurrentCount);
      const prepared = await Promise.all(trackData.map(async (track: { trackId: number; info: Array<{ id: number; sources: "storyboard" | "assets"; fileType?: "image" | "video" | "audio" }>; idempotencyKey: string; generation?: { duration?: number; resolution?: string; audio?: boolean } }) => {
        try {
          const result = await prepareRuntimeVideoPromptJob( { projectId, scriptId, trackId: track.trackId, model, mode, info: track.info, idempotencyKey: track.idempotencyKey, generation: track.generation });
          return { trackId: track.trackId, job: result.job, reused: result.reused };
        } catch (e) {
          await markVideoPromptPreparationFailed(u.db, { projectId, scriptId, trackId: track.trackId }, u.error(e).message).catch(() => undefined);
          return { trackId: track.trackId, job: undefined, reused: false, failure: u.error(e).message };
        }
      }));
      const initial = prepared.map((item) => ({ trackId: item.trackId, jobId: item.job?.id ?? null, state: item.failure ? "failed" : item.job?.state ?? "failed", reason: item.failure ?? item.job?.reason ?? null }));
      res.status(200).send(success(initial));
      const tasks = prepared.filter((item) => item.job && !item.failure && !["succeeded", "failed", "running"].includes(item.job.state)).map((item) => limit(async () => {
        await executeVideoPromptJob(u.db, item.job!.id, generateRuntimeVideoPrompt);
      }));
      void Promise.all(tasks).catch(() => undefined);
      return;
    } catch (e) {
      return res.status(400).send(error(u.error(e).message));
    }
  },
);
