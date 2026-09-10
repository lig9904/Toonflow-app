import express from "express";
import { videoPromptSystem } from "@/lib/videoPromptContract";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import fs from "fs/promises";
import path from "path";
import { isSeedance2Model } from "@/lib/videoPromptReferences";
import { executeVideoPromptJob, markVideoPromptPreparationFailed, prepareVideoPromptJob } from "@/services/videoPromptJobs";

const router = express.Router();
const infoSchema = z.object({ id: z.number().int().positive(), sources: z.enum(["storyboard", "assets"]), fileType: z.enum(["image", "video", "audio"]).optional() });

async function promptSystem(model: string, mode: string): Promise<string | undefined> {
  const [vendorId, modelName] = model.split(/:(.+)/);
  const bound = await u.db("o_modelPrompt").where("vendorId", vendorId).where("model", modelName).first();
  let system: string | undefined;
  if (bound) {
    try { system = await fs.readFile(path.join(u.getPath(["modelPrompt"]), String(bound.path)), "utf-8"); } catch {}
  }
  if (!system) {
    const lower = (modelName ?? "").toLowerCase();
    const fileName = lower.includes("wan") && lower.includes("2.6")
      ? "wan2.6Single-imageFirstFrameMode.md"
      : isSeedance2Model(lower)
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
    projectId: z.number(), scriptId: z.number(), trackId: z.number(), info: z.array(infoSchema), model: z.string(), mode: z.string(), idempotencyKey: z.string().min(8).max(150),
  }),
  async (req, res) => {
    const { trackId, projectId, scriptId, info, model, mode, idempotencyKey } = req.body;
    try {
      const project = await u.db("o_project").where({ id: projectId }).select("id", "artStyle").first();
      if (!project) return res.status(400).send(error("项目不存在"));
      const system = await promptSystem(model, mode);
      const visualManual = u.getArtPrompt(project.artStyle || "无", "art_skills", "art_storyboard_video");
      const prepared = await prepareVideoPromptJob(u.db, { projectId, scriptId, trackId, model, mode, info, idempotencyKey });
      const result = await executeVideoPromptJob(u.db, prepared.job.id, async (job) => {
        const response = await u.Ai.Text("universalAi").invoke({ system: videoPromptSystem(system), messages: [{ role: "assistant", content: visualManual }, { role: "user", content: `模型：${model}\n${job.promptInput}` }] });
        return response.text;
      });
      if (result.state === "running" || result.state === "queued") return res.status(202).send(success({ state: result.state, jobId: result.id }));
      if (result.state === "failed") return res.status(400).send(error(result.reason ?? "提示词生成失败"));
      return res.status(200).send(success(result.resultPrompt ?? ""));
    } catch (e) {
      await markVideoPromptPreparationFailed(u.db, { projectId, scriptId, trackId }, u.error(e).message).catch(() => undefined);
      return res.status(400).send(error(u.error(e).message));
    }
  },
);
