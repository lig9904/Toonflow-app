import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { updateDerivedAssetImage } from "@/services/productionAssets";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    url: z.string(),
    flowId: z.number(),
    projectId: z.number(),
    scriptId: z.number(),
  }),
  async (req, res) => {
    try {
      const { id, url, flowId, projectId, scriptId } = req.body;
      await requireProductionOwner(req, projectId, u.db);
      await updateDerivedAssetImage(u.db, { id, url: u.replaceUrl(url), flowId, projectId, scriptId: Number(scriptId) });
      res.status(200).send(success({ message: "更新提示词成功" }));
    } catch (error) { sendProductionError(res, error); }
  },
);
