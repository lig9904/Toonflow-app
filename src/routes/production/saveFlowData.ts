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
  saveIntent: z.enum(["manual", "generated", "order"]).optional(),
  field: z.enum(["scriptPlan", "storyboardTable"]).optional(),
  allowClear: z.boolean().optional(),
  data: z.object({ scriptPlan: z.string(), storyboardTable: z.string(), storyboard: z.array(z.object({
    id: z.number().int().positive().optional(), collaboration: z.object({ version: z.number().int().nonnegative() }).optional(),
  })).optional() }),
}).strict();
export default express.Router().post("/", async (req, res) => {
  try {
    const data = schema.parse(req.body);
    await requireProductionOwner(req, data.projectId, u.db);
    if ((data.saveIntent === "manual" || data.saveIntent === "generated") && !data.field) {
      return res.status(400).send({ code: "EXPLICIT_FIELD_REQUIRED", message: "正文保存必须指定编辑字段" });
    }
    if (!data.saveIntent) return res.status(409).send({ code: "CLIENT_REFRESH_REQUIRED", message: "页面保存逻辑已更新，请刷新页面后重新编辑；原有正文未修改" });
    const fields = data.saveIntent === "manual" || data.saveIntent === "generated" ? [data.field!] : [];
    const result = await saveProductionPlanning(u.db, data.projectId, data.episodesId, data.expectedPlanningVersion, data.data,
      { fields, allowClear: data.saveIntent === "manual" && data.allowClear === true });
    notifyProductionChange({ projectId: data.projectId, scriptId: data.episodesId });
    res.send(success(result));
  } catch (error) { sendProductionError(res, error); }
});
