import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { reconcileManualExtractionStates } from "@/services/builtinAgent/manualAssetExtraction";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    ids: z.array(z.number()),
  }),
  async (req, res) => {
    const { ids } = req.body;
    await reconcileManualExtractionStates(u.db, ids);
    const data = await u.db("o_script").whereIn("id", ids).whereNot("extractState", 0).select("id", "extractState", "errorReason");
    res.status(200).send(success(data));
  },
);
