import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { deleteDerivedAsset } from "@/services/productionAssets";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    projectId: z.number(),
    scriptId: z.number(),
  }),
  async (req, res) => {
    try {
      const { id, projectId, scriptId } = req.body;
      await requireProductionOwner(req, projectId, u.db);
      const child = await u.db("o_assets").where({ id, projectId }).first();
      if (!child?.assetsId) return res.status(404).send({ error: "衍生资源未找到" });
      await deleteDerivedAsset(u.db, { projectId, scriptId: Number(scriptId), parentAssetId: child.assetsId, id });
      res.status(200).send(success({ message: "视频删除成功" }));
    } catch (error) { sendProductionError(res, error); }
  },
);
