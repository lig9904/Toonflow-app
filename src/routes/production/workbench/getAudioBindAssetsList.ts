import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readBoundAudioReferences } from "@/services/roleAudioWorkspace";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    assetsIds: z.array(z.number()),
  }),
  async (req, res) => {
    const { assetsIds } = req.body;
    if (!assetsIds.length) return res.status(200).send(success([]));
    const assets = await u.db("o_assets").whereIn("id", assetsIds).select("id", "projectId", "type");
    const projectIds = [...new Set(assets.map((item) => Number(item.projectId)))];
    if (assets.length !== new Set(assetsIds).size || projectIds.length !== 1) return res.status(403).send({ code: "PROJECT_MISMATCH", message: "素材不属于同一项目" });
    const project = await u.db("o_project").where({ id: projectIds[0] }).select("mode").first();
    let mode: unknown = project?.mode;
    try { mode = JSON.parse(String(project?.mode ?? "")); } catch { /* scalar video mode */ }
    const audioMode = Array.isArray(mode) ? mode.find((item) => typeof item === "string" && item.toLowerCase().startsWith("audioreference:")) : undefined;
    const audioLimit = typeof audioMode === "string" ? Number(audioMode.split(":")[1]) : 0;
    if (!Number.isSafeInteger(audioLimit) || audioLimit <= 0) return res.status(200).send(success([]));
    const roleIds = assets.filter((item) => item.type === "role").map((item) => Number(item.id));
    const references = roleIds.length
      ? (await readBoundAudioReferences(u.db, projectIds[0], roleIds)).filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index).slice(0, audioLimit)
      : [];
    const data = await Promise.all(references.map(async (item) => ({
      fileType: "audio" as const,
      sources: "assets",
      src: await u.oss.getFileUrl(item.filePath),
      id: item.id,
      prompt: item.prompt,
    })));
    return res.status(200).send(success(data));
  },
);
