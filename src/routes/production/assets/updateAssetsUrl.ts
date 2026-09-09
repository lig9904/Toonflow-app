import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { ProductionAssetError, updateDerivedAssetImage } from "@/services/productionAssets";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    url: z.string(),
    flowId: z.number(),
    projectId: z.number(),
    scriptId: z.number(),
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(8).max(180).optional(),
  }),
  async (req, res) => {
    try {
      const { id, url, flowId, projectId, scriptId, expectedVersion } = req.body;
      const actor = await requireProductionOwner(req, projectId, u.db);
      const headerKey = req.get("Idempotency-Key");
      const idempotencyKey = req.body.idempotencyKey ?? headerKey;
      if (!idempotencyKey) throw new ProductionAssetError("选择衍生素材候选图片需要幂等操作编号", 400, "INVALID_INPUT");
      const result = await updateDerivedAssetImage(u.db, { id, url: u.replaceUrl(url), flowId, projectId, scriptId: Number(scriptId), expectedVersion, idempotencyKey, actor });
      res.status(200).send(success(result, "衍生素材候选图片已更新"));
    } catch (error) { sendProductionError(res, error); }
  },
);
