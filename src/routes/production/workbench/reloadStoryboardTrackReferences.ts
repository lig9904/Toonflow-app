import express, { type Request, type Response } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { getConfiguredMediaModel } from "@/utils/ai";
import { reloadStoryboardTrackReferences, resolveStoredVideoMode, VideoModeResolutionError } from "@/services/videoModeResolution";

function sendError(res: Response, error: unknown) { if (error instanceof VideoModeResolutionError) return res.status(error.status).send({ code: error.code, message: error.message }); return sendProductionError(res, error); }
export default express.Router().post("/", async (req: Request, res: Response) => {
  try {
    const actor = await requireProductionOwner(req, Number(req.body?.projectId), u.db), result = await reloadStoryboardTrackReferences(u.db, req.body, actor.id, (filePath) => u.oss.getImageBase64(filePath));
    const project = await u.db("o_project").where({ id: req.body.projectId }).first("videoModel");
    try {
      if (!project?.videoModel) throw new Error("项目尚未配置视频模型");
      const modeResolution = await resolveStoredVideoMode(u.db, { projectId: req.body.projectId, scriptId: req.body.scriptId, trackId: req.body.trackId, model: project.videoModel, capabilities: await getConfiguredMediaModel(project.videoModel, "video"), references: result.references, expectedIntentRevision: result.revision });
      return res.send(success({ ...result, compatibility: { ok: true }, modeResolution }));
    } catch (error) {
      return res.send(success({ ...result, compatibility: { ok: false, code: error instanceof VideoModeResolutionError ? error.code : "VIDEO_MODE_INCOMPATIBLE", message: error instanceof Error ? error.message : "当前模型与重新载入的参考素材不兼容" } }));
    }
  } catch (error) { return sendError(res, error); }
});
