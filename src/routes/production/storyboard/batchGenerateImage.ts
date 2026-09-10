import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { prepareStoryboardImages, ProductionImageError } from "@/services/productionImages";
import { createDurableProductionImageRuntime } from "@/services/productionImageJobRuntime";
import { ImageGenerationError } from "@/services/imageJobs/runtime";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    storyboardIds: z.array(z.number()).min(1),
    projectId: z.number(),
    scriptId: z.number(),
    concurrentCount: z.number().min(1).max(20).optional(),
    compulsory: z.boolean().optional(),
    idempotencyKey: z.string().min(8).max(180).optional(),
  }),
  async (req, res) => {
    try {
      const { storyboardIds, projectId, scriptId, concurrentCount = 5, compulsory = false } = req.body;
      await requireProductionOwner(req, projectId, u.db);
      const headerKey = req.get("Idempotency-Key");
      const generationKeyPrefix = req.body.idempotencyKey ?? (headerKey && headerKey.length >= 8 ? headerKey : `web-storyboard:${projectId}:${scriptId}:${u.uuid()}`);
      const prepared = await prepareStoryboardImages(u.db, { projectId, scriptId, storyboardIds, concurrentCount, compulsory, runtime: createDurableProductionImageRuntime(), generationKeyPrefix });
      res.status(202).send(success(prepared.preview, "已接受分镜图片生成任务"));
      void prepared.run().catch((error) => console.error("[productionStoryboard] background generation failed", error));
    } catch (error) {
      if (error instanceof ProductionImageError || error instanceof ImageGenerationError) return res.status(error.status).send({ code: error.status, message: error.message });
      return sendProductionError(res, error);
    }
  },
);
