import type { Request, Response } from "express";
import { NovelEventWorkspaceError } from "./index";

export function novelEventUserId(req: Request): number {
  const value = Number((req as any).teamPrincipal?.id ?? (req as any).user?.id);
  if (!Number.isSafeInteger(value) || value <= 0) throw new NovelEventWorkspaceError("INVALID_INPUT", "请先登录", 401);
  return value;
}

export function novelEventActor(req: Request) {
  return { id: `human:${novelEventUserId(req)}`, kind: "human" as const };
}

export function sendNovelEventError(res: Response, error: unknown): Response {
  if (error instanceof NovelEventWorkspaceError) return res.status(error.status).send({ code: error.code, message: error.message });
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  if ([400, 401, 403, 404, 409, 423, 503].includes(Number(value?.status))) return res.status(Number(value.status)).send({ code: value.code ?? "REQUEST_FAILED", message: value.message ?? "事件操作失败" });
  return res.status(500).send({ code: "INTERNAL_ERROR", message: "事件操作失败" });
}
