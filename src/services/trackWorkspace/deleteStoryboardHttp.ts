import express, { type Request, type Response } from "express";
import type { Knex } from "knex";
import { success } from "../../lib/responseFormat";
import { requireProductionOwner, sendProductionError } from "../productionHttp";
import { notifyProductionChange } from "../productionEvents";
import { batchDeleteStoryboardTracks, deleteStoryboardTrack, TrackWorkspaceError } from "./index";

function sendError(res: Response, error: unknown) { if (error instanceof TrackWorkspaceError) return res.status(error.code === "LOCKED" ? 423 : ["VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "ACTIVE_JOB", "MIGRATION_REQUIRED"].includes(error.code) ? 409 : error.code === "PROJECT_MISMATCH" ? 403 : 400).send({ code: error.code, message: error.message }); return sendProductionError(res, error); }
export function createDeleteStoryboardTrackRouter(db: Knex) { return express.Router().post("/", async (req: Request, res: Response) => { try { const projectId = Number(req.body?.projectId); const actor = await requireProductionOwner(req, projectId, db); const result = await deleteStoryboardTrack(db, req.body, actor); notifyProductionChange({ projectId, scriptId: Number(req.body?.scriptId), storyboardId: Number(req.body?.storyboardId) }); return res.send(success(result)); } catch (error) { return sendError(res, error); } }); }
export function createBatchDeleteStoryboardTracksRouter(db: Knex) { return express.Router().post("/", async (req: Request, res: Response) => { try { const projectId = Number(req.body?.projectId); const actor = await requireProductionOwner(req, projectId, db); const result = await batchDeleteStoryboardTracks(db, req.body, actor); for (const item of result.items ?? []) notifyProductionChange({ projectId, scriptId: Number(req.body?.items?.find((source: any) => Number(source?.storyboardId) === Number(item.storyboardId))?.scriptId), storyboardId: Number(item.storyboardId) }); return res.send(success(result)); } catch (error) { return sendError(res, error); } }); }
