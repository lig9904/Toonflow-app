import type { Request, Response } from "express";
import { ImageFlowWorkspaceError } from ".";

export function imageFlowUserId(req: Request): number {
  const value = Number((req as any).teamPrincipal?.id ?? (req as any).user?.id);
  if (!Number.isSafeInteger(value) || value <= 0) throw Object.assign(new Error("请先登录"), { status: 401, code: "UNAUTHORIZED" });
  return value;
}

export function imageFlowActor(req: Request) {
  return { id: `human:${imageFlowUserId(req)}`, kind: "human" as const };
}

export function sendImageFlowError(res: Response, error: unknown) {
  if (error instanceof ImageFlowWorkspaceError) {
    const status = {
      INVALID_INPUT: 400,
      NOT_FOUND: 404,
      PROJECT_MISMATCH: 403,
      VERSION_CONFLICT: 409,
      IDEMPOTENCY_CONFLICT: 409,
      AMBIGUOUS_OWNER: 409,
    }[error.code];
    return res.status(status).send({ code: error.code, message: error.message });
  }
  const value = error as any;
  const status = [400, 401, 403, 404, 409, 423].includes(Number(value?.status)) ? Number(value.status) : 500;
  return res.status(status).send({ code: value?.code ?? "IMAGE_FLOW_FAILED", message: value?.message ?? "图片工作流操作失败" });
}
