import express, { type Request, type Response } from "express";
import u from "@/utils";
import { z } from "zod";
import { ZodError } from "zod";
import { success } from "@/lib/responseFormat";
import { requireProjectAccess, TeamSecurityError } from "@/services/team";
import { EditTimelineError, readEditTimeline } from "@/services/editTimeline";

function userId(req: Request): number {
  const id = Number((req as any).teamPrincipal?.id ?? (req as any).user?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TeamSecurityError("SESSION_REQUIRED", "需要团队会话", 401);
  return id;
}

function sendError(res: Response, error: unknown) {
  if (error instanceof ZodError) return res.status(400).send({ code: "INVALID_INPUT", message: "参数错误", errors: error.issues.map((issue) => issue.message) });
  if (error instanceof TeamSecurityError) return res.status(error.status).send({ code: error.code, message: error.message });
  if (error instanceof EditTimelineError) {
    const status = { INVALID_INPUT: 400, NOT_FOUND: 404, PROJECT_MISMATCH: 403, VERSION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409 }[error.code];
    return res.status(status).send({ code: error.code, message: error.message, current: error.current });
  }
  return res.status(500).send({ code: "EDIT_TIMELINE_READ_FAILED", message: "时间线读取失败" });
}

export default express.Router().post("/", async (req, res) => {
  try {
    const data = z.object({ projectId: z.coerce.number().int().positive(), scriptId: z.coerce.number().int().positive() }).strict().parse(req.body);
    await requireProjectAccess(u.db, userId(req), data.projectId, "read");
    return res.send(success(await readEditTimeline(u.db, data.projectId, data.scriptId)));
  } catch (error) {
    return sendError(res, error);
  }
});
