import express from "express";
import type {Knex} from "knex";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { reconcileManualPolishStates } from "@/services/builtinAgent/manualAssetPolish";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    ids: z.array(z.number()),
  }),
  async (req, res) => {
    const { ids } = req.body;
    await reconcileManualPolishStates(u.db, ids);
    const data = await u.db("o_assets").whereIn("id", ids).whereNot("promptState", "生成中").select("*");
    const states: any[] = data.length ? await (u.db as Knex)<any>("ext_creative_state").where({entityType:"asset"}).whereIn("entityId",data.map(a => Number(a.id))) : [];
    res.status(200).send(success(data.map(a => ({...a,version:Number(states.find(s => Number(s.entityId)===Number(a.id))?.version??0)}))));
  },
);
