import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { saveProductionPlanning } from "@/services/productionFlow";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { notifyProductionChange } from "@/services/productionEvents";
const schema = z.object({
  projectId: z.coerce.number().int().positive(), episodesId: z.coerce.number().int().positive(),
  expectedPlanningVersion: z.number().int().nonnegative(),
  data: z.object({ scriptPlan: z.string(), storyboardTable: z.string(), storyboard: z.array(z.object({
    id: z.number().int().positive().optional(), collaboration: z.object({ version: z.number().int().nonnegative() }).optional(),
  })).optional() }),
}).strict();
export default express.Router().post("/", async (req, res) => {
  try {
    const data = schema.parse(req.body);
    await requireProductionOwner(req, data.projectId, u.db);
    const result = await saveProductionPlanning(u.db, data.projectId, data.episodesId, data.expectedPlanningVersion, data.data);
    notifyProductionChange({ projectId: data.projectId, scriptId: data.episodesId });
    res.send(success(result));
  } catch (error) { sendProductionError(res, error); }
});
