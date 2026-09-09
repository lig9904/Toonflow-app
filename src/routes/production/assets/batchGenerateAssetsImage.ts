import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { prepareDerivedAssetImages, ProductionImageError } from "@/services/productionImages";
import { createDurableProductionImageRuntime } from "@/services/productionImageJobRuntime";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    assetIds: z.array(z.number()).min(1),
    projectId: z.number(),
    scriptId: z.number(),
    concurrentCount: z.number().min(1).max(20).optional(),
    idempotencyKey: z.string().min(8).max(180).optional(),
  }),
  async (req, res) => {
    try {
      const { assetIds, projectId, scriptId, concurrentCount = 5 } = req.body;
      await requireProductionOwner(req, projectId, u.db);
      const headerKey = req.get("Idempotency-Key");
      const generationKeyPrefix = req.body.idempotencyKey ?? (headerKey && headerKey.length >= 8 ? headerKey : `web-derived:${projectId}:${scriptId}:${u.uuid()}`);
      const prepared = await prepareDerivedAssetImages(u.db, { projectId, scriptId, assetIds, concurrentCount, runtime: createDurableProductionImageRuntime(), generationKeyPrefix });
      res.status(202).send(success(prepared.preview, "已接受图片生成任务"));
      void prepared.run().catch((error) => console.error("[productionAssets] background generation failed", error));
    } catch (error) {
      if (error instanceof ProductionImageError) return res.status(error.status).send({ error: error.message });
      return sendProductionError(res, error);
    }
  },
);
