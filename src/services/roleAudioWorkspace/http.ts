import type { Request, Response } from "express";
import { RoleAudioWorkspaceError } from "./index";

export function userId(req: Request): number {
  const value = Number((req as any).teamPrincipal?.id ?? (req as any).user?.id);
  if (!Number.isSafeInteger(value) || value <= 0) throw new RoleAudioWorkspaceError("INVALID_INPUT", "请先登录", 401);
  return value;
}

export function actor(req: Request) {
  return { id: `human:${userId(req)}`, kind: "human" as const };
}

export function sendRoleAudioError(res: Response, error: unknown): Response {
  if (error instanceof RoleAudioWorkspaceError) return res.status(error.status).send({ code: error.code, message: error.message });
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  if ([400, 401, 403, 404, 409, 423, 503].includes(Number(value?.status))) return res.status(Number(value.status)).send({ code: value.code ?? "REQUEST_FAILED", message: value.message ?? "音色绑定失败" });
  return res.status(500).send({ code: "INTERNAL_ERROR", message: "音色绑定失败" });
}
