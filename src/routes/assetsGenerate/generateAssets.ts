import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getProductionImageGenerationService } from "@/services/productionImageJobRuntime";
import { generateRootAssetImage } from "@/services/rootAssetImages";
import { imageGenerationErrorStatus } from "@/services/imageJobs/runtime";

const router = express.Router();

const requestSchema = {
  projectId: z.number(), model: z.string(), resolution: z.string(), id: z.number(),
  type: z.enum(["role", "scene", "tool"]), name: z.string(), prompt: z.string(),
  base64: z.string().optional().nullable(), idempotencyKey: z.string().min(8).max(200).optional(),
};

export default router.post("/", validateFields(requestSchema), async (req, res) => {
  const { projectId, model, resolution, id, type, name, prompt, base64 } = req.body;
  const headerKey = req.get("Idempotency-Key");
  const generationKey = req.body.idempotencyKey ?? (headerKey && headerKey.length >= 8 ? headerKey : `web-asset:${projectId}:${id}:${u.uuid()}`);
  try {
    const receipt = await generateRootAssetImage(u.db, getProductionImageGenerationService(), {
      projectId, assetId: id, type, name, prompt, model, resolution, base64, generationKey,
    });
    if (receipt.status === "succeeded" && receipt.artifactPath) {
      return res.status(200).send(success({ path: await u.oss.getSmallImageUrl(receipt.artifactPath), assetsId: id, jobId: receipt.jobId }));
    }
    if (receipt.status === "pending") return res.status(202).send(success({ path: null, assetsId: id, jobId: receipt.jobId }, "已接受图片生成任务"));
    return res.status(receipt.status === "needs_reconciliation" ? 409 : 400).send(error(receipt.error || "图片生成失败"));
  } catch (e) {
    const declared = Number((e as { status?: number }).status);
    return res.status(Number.isInteger(declared) && declared >= 400 ? declared : imageGenerationErrorStatus(e)).send(error(u.error(e).message || "图片生成失败"));
  }
});
