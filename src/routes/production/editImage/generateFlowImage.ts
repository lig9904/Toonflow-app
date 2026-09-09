import express from "express";
import axios from "axios";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getProductionImageGenerationService } from "@/services/productionImageJobRuntime";
import { generateFlowImage } from "@/services/productionEditImages";

const router = express.Router();

async function remoteImageBase64(imageUrl: string): Promise<string> {
  const response = await axios.get<ArrayBuffer>(imageUrl, { responseType: "arraybuffer", timeout: 30_000, maxContentLength: 20 * 1024 * 1024 });
  const contentType = String(response.headers["content-type"] || "image/png");
  return `data:${contentType};base64,${Buffer.from(response.data).toString("base64")}`;
}

export default router.post(
  "/",
  validateFields({
    model: z.string(), references: z.array(z.string()).optional(), quality: z.string(), ratio: z.string(), prompt: z.string(), projectId: z.number(),
    scriptId: z.number().optional(), flowId: z.number().optional(), nodeId: z.string().max(200).optional(), idempotencyKey: z.string().min(8).max(200).optional(),
  }),
  async (req, res) => {
    const { model, references = [], quality, ratio, prompt, projectId, scriptId, flowId, nodeId } = req.body;
    const headerKey = req.get("Idempotency-Key");
    const generationKey = req.body.idempotencyKey ?? (headerKey && headerKey.length >= 8 ? headerKey : `web-flow:${projectId}:${flowId ?? nodeId ?? u.uuid()}:${u.uuid()}`);
    try {
      const receipt = await generateFlowImage(u.db, getProductionImageGenerationService(), {
        model, references, quality, ratio, prompt, projectId, scriptId, flowId, nodeId, generationKey,
      }, {
        local: (path) => u.oss.getImageBase64(path),
        remote: remoteImageBase64,
      });
      if (receipt.status === "succeeded" && receipt.artifactPath) {
        return res.status(200).send(success({ url: await u.oss.getSmallImageUrl(receipt.artifactPath), jobId: receipt.jobId }));
      }
      if (receipt.status === "pending") return res.status(202).send(success({ url: null, jobId: receipt.jobId }, "已接受图片生成任务"));
      return res.status(receipt.status === "needs_reconciliation" ? 409 : 400).send(error(receipt.error ?? "图片生成失败"));
    } catch (e) {
      return res.status(Number((e as { status?: number }).status) || 400).send(error(u.error(e).message));
    }
  },
);
