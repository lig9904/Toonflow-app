import express, { type Request, type Response } from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { getConfiguredMediaModel } from "@/utils/ai";
import { resolveStoredVideoMode, VideoModeResolutionError } from "@/services/videoModeResolution";

const reference = z.object({ id: z.number().int().positive(), sources: z.enum(["storyboard", "assets"]), fileType: z.enum(["image", "video", "audio"]).optional(), purpose: z.enum(["first_frame", "last_frame", "identity_reference", "style_reference", "motion_reference", "audio_reference"]).optional() }).strict();
const schema = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(), trackId: z.number().int().positive(), model: z.string().min(1), references: z.array(reference).max(100), modeIntentRevision: z.number().int().nonnegative().optional() }).strict();
function sendError(res: Response, error: unknown) { if (error instanceof VideoModeResolutionError) return res.status(error.status).send({ code: error.code, message: error.message }); return sendProductionError(res, error); }

export default express.Router().post("/", async (req: Request, res: Response) => {
  try {
    const input = schema.parse(req.body); await requireProductionOwner(req, input.projectId, u.db);
    const result = await resolveStoredVideoMode(u.db, { ...input, capabilities: await getConfiguredMediaModel(input.model, "video"), expectedIntentRevision: input.modeIntentRevision });
    return res.send(success(result));
  } catch (error) { return sendError(res, error); }
});
