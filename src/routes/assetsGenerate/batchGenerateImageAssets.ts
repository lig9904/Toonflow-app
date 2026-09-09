import express from "express";
import pLimit from "p-limit";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getProductionImageGenerationService } from "@/services/productionImageJobRuntime";
import { prepareRootAssetImage } from "@/services/rootAssetImages";

const router = express.Router();

const requestSchema = {
  projectId: z.number(), model: z.string(), resolution: z.string(), concurrentCount: z.number().int().min(1).max(20).optional(),
  idempotencyKey: z.string().min(8).max(180).optional(),
  items: z.array(z.object({ id: z.number(), type: z.enum(["role", "scene", "tool"]), name: z.string(), prompt: z.string(), base64: z.string().optional().nullable() })).min(1),
};

export default router.post("/", validateFields(requestSchema), async (req, res) => {
  const { projectId, model, resolution, concurrentCount = 1, items } = req.body;
  const headerKey = req.get("Idempotency-Key");
  const prefix = req.body.idempotencyKey ?? (headerKey && headerKey.length >= 8 ? headerKey : `web-asset-batch:${projectId}:${u.uuid()}`);
  const jobs = getProductionImageGenerationService();
  try {
    const attempts = await Promise.allSettled(items.map((item: (typeof items)[number]) => prepareRootAssetImage(u.db, jobs, {
      projectId, assetId: item.id, type: item.type, name: item.name, prompt: item.prompt,
      model, resolution, base64: item.base64, generationKey: `${prefix}:asset:${item.id}`,
    })));
    const prepared = attempts.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
    const failures = attempts.flatMap((item, index) => item.status === "rejected" ? [{ id: items[index].id, error: u.error(item.reason).message }] : []);
    if (!prepared.length) return res.status(400).send(error(failures[0]?.error || "图片生成任务创建失败"));
    const limit = pLimit(concurrentCount);
    void Promise.all(prepared.map((receipt) => limit(async () => {
      const result = await jobs.submitAndWait({ projectId, jobId: receipt.jobId });
      if (result.status === "failed" || result.status === "needs_reconciliation") console.error(`[assetsGenerate] image job ${result.jobId}: ${result.error ?? result.status}`);
    }))).catch((cause) => console.error("[assetsGenerate] background batch failed", cause));
    return res.status(200).send(success({ total: items.length, jobIds: prepared.map((item) => item.jobId), failures }));
  } catch (e) {
    return res.status(Number((e as { status?: number }).status) || 400).send(error(u.error(e).message || "图片生成任务创建失败"));
  }
});
