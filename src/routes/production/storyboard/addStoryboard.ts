import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { assertEpisode } from "@/services/productionFlow";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { ProductionStateService } from "@/services/productionState";
import { notifyProductionChange } from "@/services/productionEvents";
import { insertRowsReturningIds } from "@/lib/insertRows";
const schema = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(),
  prompt: z.string(), duration: z.number().finite().nonnegative(), videoDesc: z.string(), src: z.string().nullable(),
  flowId: z.number().int().positive().optional(), state: z.string().optional(), shouldGenerateImage: z.number().optional() });
export default express.Router().post("/", async (req, res) => {
  try {
    const data = schema.parse(req.body);
    await requireProductionOwner(req, data.projectId, u.db);
    const id = await u.db.transaction(async (trx) => {
      await assertEpisode(trx, data.projectId, data.scriptId);
      const [trackId] = await insertRowsReturningIds(trx, "o_videoTrack", { projectId: data.projectId, scriptId: data.scriptId, duration: data.duration });
      const last = await trx("o_storyboard").where({ scriptId: data.scriptId }).max("index as last").first();
      const [id] = await insertRowsReturningIds(trx, "o_storyboard", { projectId: data.projectId, scriptId: data.scriptId, trackId,
        index: Number(last?.last ?? -1) + 1, prompt: data.prompt, duration: String(data.duration), videoDesc: data.videoDesc,
        filePath: u.replaceUrl(data.src ?? ""), flowId: data.flowId, state: data.src ? "已完成" : "未生成", shouldGenerateImage: data.src ? 1 : 0 });
      return id;
    });
    const state = await new ProductionStateService(u.db).getStoryboardState(data.projectId, id);
    notifyProductionChange({ projectId: data.projectId, scriptId: data.scriptId, storyboardId: id });
    res.send(success({ id, collaboration: state.state }));
  } catch (error) { sendProductionError(res, error); }
});
