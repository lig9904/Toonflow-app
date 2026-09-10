import express from "express";
import { videoPromptSystem } from "@/lib/videoPromptContract";
import u from "@/utils";
import pLimit from "p-limit";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import fs from "fs/promises";
import path from "path";
import { isSeedance2Model } from "@/lib/videoPromptReferences";
import { executeVideoPromptJob, markVideoPromptPreparationFailed, prepareVideoPromptJob } from "@/services/videoPromptJobs";

const infoSchema = z.object({ id: z.number().int().positive(), sources: z.enum(["storyboard", "assets"]), fileType: z.enum(["image", "video", "audio"]).optional() });
const router = express.Router();

async function promptSystem(model: string, mode: string): Promise<string | undefined> {
  const [vendorId, modelName] = model.split(/:(.+)/);
  const bound = await u.db("o_modelPrompt").where("vendorId", vendorId).where("model", modelName).first();
  let system: string | undefined;
  if (bound) {
    try { system = await fs.readFile(path.join(u.getPath(["modelPrompt"]), String(bound.path)), "utf-8"); } catch {}
  }
  if (!system) {
    const modelLower = (modelName ?? "").toLowerCase();
    const fileName = modelLower.includes("wan") && modelLower.includes("2.6")
      ? "wan2.6Single-imageFirstFrameMode.md"
      : isSeedance2Model(modelLower)
        ? "seedance2Multi-parameterMode.md"
        : mode === "startEndRequired" || mode === "endFrameOptional" || mode === "startFrameOptional"
          ? "universalFirstAndLastFrameMode.md"
          : typeof mode === "string" && mode.startsWith("[\"") && mode.endsWith("\"]")
            ? "universalMulti-parameterMode.md"
            : null;
    if (fileName) {
      try { system = await fs.readFile(path.join(u.getPath(["modelPrompt"]), "video", fileName), "utf-8"); } catch {}
    }
  }
  if (system) return system;
  const fallback = await u.db("o_prompt").where("type", "videoPromptGeneration").first();
  return fallback?.useData || fallback?.data || undefined;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackData: z.array(z.object({ trackId: z.number().int().positive(), info: z.array(infoSchema), idempotencyKey: z.string().min(8).max(150) })).min(1).max(100),
    mode: z.string(),
    model: z.string().min(1),
    concurrentCount: z.number().int().min(1).max(20).optional(),
  }),
  async (req, res) => {
    const { trackData, projectId, scriptId, mode, model, concurrentCount = 5 } = req.body;
    try {
      const projectData = await u.db("o_project").where({ id: projectId }).first();
      if (!projectData) return res.status(400).send(error("项目不存在"));
      const system = await promptSystem(model, mode);
      const visualManual = u.getArtPrompt(projectData.artStyle || "无", "art_skills", "art_storyboard_video");
      const limit = pLimit(concurrentCount);
      const prepared = await Promise.all(trackData.map(async (track: { trackId: number; info: Array<{ id: number; sources: "storyboard" | "assets"; fileType?: "image" | "video" | "audio" }>; idempotencyKey: string }) => {
        try {
          const result = await prepareVideoPromptJob(u.db, { projectId, scriptId, trackId: track.trackId, model, mode, info: track.info, idempotencyKey: track.idempotencyKey });
          return { trackId: track.trackId, job: result.job, reused: result.reused };
        } catch (e) {
          await markVideoPromptPreparationFailed(u.db, { projectId, scriptId, trackId: track.trackId }, u.error(e).message).catch(() => undefined);
          return { trackId: track.trackId, job: undefined, reused: false, failure: u.error(e).message };
        }
      }));
      const initial = prepared.map((item) => ({ trackId: item.trackId, jobId: item.job?.id ?? null, state: item.failure ? "failed" : item.job?.state ?? "failed", reason: item.failure ?? item.job?.reason ?? null }));
      res.status(200).send(success(initial));
      const tasks = prepared.filter((item) => item.job && !item.failure && !["succeeded", "failed", "running"].includes(item.job.state)).map((item) => limit(async () => {
        await executeVideoPromptJob(u.db, item.job!.id, async (job) => {
          const response = await u.Ai.Text("universalAi").invoke({ system: videoPromptSystem(system), messages: [{ role: "assistant", content: visualManual }, { role: "user", content: `模型：${model}\n${job.promptInput}` }] });
          return response.text;
        });
      }));
      void Promise.all(tasks).catch(() => undefined);
      return;
    } catch (e) {
      return res.status(400).send(error(u.error(e).message));
    }
  },
);
