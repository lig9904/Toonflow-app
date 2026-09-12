import express, { type Request, type Response } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { clearTrackVideos, TrackWorkspaceError } from "@/services/trackWorkspace";

function sendError(res: Response, error: unknown) { if (error instanceof TrackWorkspaceError) return res.status(error.code === "LOCKED" ? 423 : ["VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "ACTIVE_JOB", "MIGRATION_REQUIRED"].includes(error.code) ? 409 : error.code === "PROJECT_MISMATCH" ? 403 : 400).send({ code: error.code, message: error.message }); return sendProductionError(res, error); }
export default express.Router().post("/", async (req: Request, res: Response) => { try { const actor = await requireProductionOwner(req, Number(req.body?.projectId), u.db); return res.send(success(await clearTrackVideos(u.db, req.body, actor))); } catch (error) { return sendError(res, error); } });
