import express, { type Request, type Response } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { planIndependentStoryboardTracks, StoryboardTrackIndependenceError } from "@/services/storyboardTrackIndependence";

function sendError(res: Response, error: unknown) { if (error instanceof StoryboardTrackIndependenceError) return res.status(error.status).send({ code: error.code, message: error.message }); return sendProductionError(res, error); }
export default express.Router().post("/", async (req: Request, res: Response) => { try { await requireProductionOwner(req, Number(req.body?.projectId), u.db); return res.send(success(await planIndependentStoryboardTracks(u.db, req.body))); } catch (error) { return sendError(res, error); } });
