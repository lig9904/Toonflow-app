import express, { type Request, type Response } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { requireProjectAccess, TeamSecurityError } from "@/services/team";
import { createTrack, TrackWorkspaceError } from "@/services/trackWorkspace";

function userId(req: Request): number {
  const id = Number((req as any).teamPrincipal?.id ?? (req as any).user?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TeamSecurityError("SESSION_REQUIRED", "需要团队会话", 401);
  return id;
}

function sendError(res: Response, error: unknown) {
  if (error instanceof TeamSecurityError) return res.status(error.status).send({ code: error.code, message: error.message });
  if (error instanceof TrackWorkspaceError) {
    const status = { INVALID_INPUT: 400, NOT_FOUND: 404, PROJECT_MISMATCH: 403, VERSION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, LOCKED: 423, ACTIVE_JOB: 409 }[error.code];
    return res.status(status).send({ code: error.code, message: error.message });
  }
  return res.status(500).send({ code: "TRACK_CREATE_FAILED", message: "视频轨道创建失败" });
}

export default express.Router().post("/", async (req, res) => {
  try {
    const id = userId(req);
    await requireProjectAccess(u.db, id, req.body?.projectId, "edit");
    const result = await createTrack(u.db, req.body, { id: `human:${id}`, kind: "human" });
    return res.send({ ...success(result.track.id), version: result.track.version, reused: result.reused });
  } catch (error) {
    return sendError(res, error);
  }
});
