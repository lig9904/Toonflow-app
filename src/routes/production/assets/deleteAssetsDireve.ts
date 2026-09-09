import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { deleteDerivedAsset, ProductionAssetError } from "@/services/productionAssets";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    projectId: z.number(),
    scriptId: z.number(),
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(8).max(180).optional(),
  }),
  async (req, res) => {
    try {
      const { id, projectId, scriptId, expectedVersion } = req.body;
      const actor = await requireProductionOwner(req, projectId, u.db);
      const headerKey = req.get("Idempotency-Key");
      const idempotencyKey = req.body.idempotencyKey ?? headerKey;
      if (!idempotencyKey) throw new ProductionAssetError("删除衍生素材需要幂等操作编号", 400, "INVALID_INPUT");
      const result = await deleteDerivedAsset(u.db, { projectId, scriptId: Number(scriptId), id, expectedVersion, idempotencyKey, actor });
      res.status(200).send(success(result, "衍生素材已删除"));
    } catch (error) { sendProductionError(res, error); }
  },
);
