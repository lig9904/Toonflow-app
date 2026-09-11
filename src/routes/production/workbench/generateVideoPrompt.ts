import { prepareRuntimeVideoPromptJob, generateRuntimeVideoPrompt } from "@/services/videoPromptCompositionRuntime";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { executeVideoPromptJob, markVideoPromptPreparationFailed } from "@/services/videoPromptJobs";

const router = express.Router();
const generationSchema = z.object({ duration: z.number().finite().positive().optional(), resolution: z.string().min(1).optional(), audio: z.boolean().optional() });
const infoSchema = z.object({ id: z.number().int().positive(), sources: z.enum(["storyboard", "assets"]), fileType: z.enum(["image", "video", "audio"]).optional() });

export default router.post(
  "/",
  validateFields({
    projectId: z.number(), scriptId: z.number(), trackId: z.number(), info: z.array(infoSchema), model: z.string(), mode: z.string(), idempotencyKey: z.string().min(8).max(150), generation: generationSchema.optional(),
  }),
  async (req, res) => {
    const { trackId, projectId, scriptId, info, model, mode, idempotencyKey, generation } = req.body;
    try {
      const project = await u.db("o_project").where({ id: projectId }).select("id", "artStyle").first();
      if (!project) return res.status(400).send(error("项目不存在"));
      const prepared = await prepareRuntimeVideoPromptJob( { projectId, scriptId, trackId, model, mode, info, idempotencyKey, generation });
      if (prepared.job.state === "failed") return res.status(400).send(error(prepared.job.reason ?? "提示词生成失败"));
      if (prepared.job.state === "succeeded") {
        const current = await u.db("o_videoTrack as track").leftJoin("ext_creative_state as state", function () {
          this.on("state.entityId", "=", "track.id").andOn("state.projectId", "=", "track.projectId").andOn("state.entityType", "=", u.db.raw("?", ["track"]));
        }).where({ "track.id": trackId, "track.projectId": projectId, "track.scriptId": scriptId }).select("track.prompt", "state.version").first();
        if (!current) return res.status(404).send(error("当前片段已删除，请刷新"));
        return res.status(200).send({ ...success(current.prompt ?? ""), version: Number(current.version ?? 0) });
      }
      // A durable receipt lets the UI follow this exact job immediately,
      // instead of keeping a model request open while polling older jobs.
      res.status(202).send(success({ state: prepared.job.state, jobId: prepared.job.id }));
      void executeVideoPromptJob(u.db, prepared.job.id, generateRuntimeVideoPrompt).catch(() => undefined); // The job records its failure for polling.
    } catch (e) {
      await markVideoPromptPreparationFailed(u.db, { projectId, scriptId, trackId }, u.error(e).message).catch(() => undefined);
      return res.status(400).send(error(u.error(e).message));
    }
  },
);
