import { prepareRuntimeVideoPromptJob, generateRuntimeVideoPrompt } from "@/services/videoPromptCompositionRuntime";
import express from "express";
import u from "@/utils";
import pLimit from "p-limit";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { executeVideoPromptJob, markVideoPromptPreparationFailed } from "@/services/videoPromptJobs";
import { getConfiguredMediaModel } from "@/utils/ai";
import { resolveStoredVideoMode, VideoModeResolutionError } from "@/services/videoModeResolution";

const infoSchema = z.object({ id: z.number().int().positive(), sources: z.enum(["storyboard", "assets"]), fileType: z.enum(["image", "video", "audio"]).optional(), purpose: z.enum(["first_frame", "last_frame", "identity_reference", "style_reference", "motion_reference", "audio_reference"]).optional() }).strict();
const router = express.Router();
const generationSchema = z.object({ duration: z.number().finite().positive().optional(), resolution: z.string().min(1).optional(), audio: z.boolean().optional() });

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackData: z.array(z.object({ trackId: z.number().int().positive(), expectedVersion: z.number().int().nonnegative(), info: z.array(infoSchema).optional(), references: z.array(infoSchema).optional(), modeIntentRevision: z.number().int().nonnegative().optional(), idempotencyKey: z.string().min(8).max(150), generation: generationSchema.optional() })).min(1).max(100),
    mode: z.union([z.string(), z.array(z.unknown())]).optional(),
    model: z.string().min(1),
    concurrentCount: z.number().int().min(1).max(20).optional(),
  }),
  async (req, res) => {
    const { trackData, projectId, scriptId, mode, model, concurrentCount = 5 } = req.body;
    try {
      const projectData = await u.db("o_project").where({ id: projectId }).first();
      if (!projectData) return res.status(400).send(error("项目不存在"));
      const capabilities = await getConfiguredMediaModel(model, "video");
      const limit = pLimit(concurrentCount);
      const prepared = await Promise.all(trackData.map(async (track: { trackId: number; expectedVersion: number; info?: Array<{ id: number; sources: "storyboard" | "assets"; fileType?: "image" | "video" | "audio"; purpose?: string }>; references?: Array<{ id: number; sources: "storyboard" | "assets"; fileType?: "image" | "video" | "audio"; purpose?: string }>; modeIntentRevision?: number; idempotencyKey: string; generation?: { duration?: number; resolution?: string; audio?: boolean } }) => {
        try {
          if (track.references !== undefined && track.info !== undefined) throw new VideoModeResolutionError("INVALID_INPUT", "references 与 info 不能同时提供");
          const modeResolution = await resolveStoredVideoMode(u.db, { projectId, scriptId, trackId: track.trackId, model, capabilities, references: track.references ?? track.info ?? [], expectedIntentRevision: track.modeIntentRevision, legacyMode: mode });
          const resolvedMode = typeof modeResolution.resolvedMode === "string" ? modeResolution.resolvedMode : JSON.stringify(modeResolution.resolvedMode);
          const result = await prepareRuntimeVideoPromptJob( { projectId, scriptId, trackId: track.trackId, model, mode: resolvedMode, info: modeResolution.resolvedReferences, ...(track.modeIntentRevision !== undefined ? { modeIntentSnapshot: { modeIntent: modeResolution.modeIntent, revision: modeResolution.modeIntentRevision } } : {}), idempotencyKey: track.idempotencyKey, expectedVersion: track.expectedVersion, generation: track.generation });
          return { trackId: track.trackId, job: result.job, reused: result.reused, modeResolution };
        } catch (e) {
          if ((e as { code?: unknown })?.code !== "VERSION_CONFLICT") await markVideoPromptPreparationFailed(u.db, { projectId, scriptId, trackId: track.trackId }, u.error(e).message).catch(() => undefined);
          return { trackId: track.trackId, job: undefined, reused: false, failure: u.error(e).message };
        }
      }));
      const initial = prepared.map((item) => ({ trackId: item.trackId, jobId: item.job?.id ?? null, state: item.failure ? "failed" : item.job?.state ?? "failed", reason: item.failure ?? item.job?.reason ?? null, modeResolution: item.modeResolution }));
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
