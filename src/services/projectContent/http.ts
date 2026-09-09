import type { Request, Response } from "express";
import { z } from "zod";
import type { TrustedActor } from "../productionState";
import { CreativeWorkspaceError } from "../creativeWorkspace";
import { ProjectContentError } from "./index";
import { success } from "../../lib/responseFormat";

export function legacyArrayResponse<T>(items: T[]) { return success(items); }
export function scriptListResponse<T>(items: T[], workspaceVersion: number) { return { ...success(items), workspaceVersion }; }

export function requestUserId(req: Request): number {
  const value = Number((req as Request & { teamPrincipal?: { id?: unknown }; user?: { id?: unknown } }).teamPrincipal?.id ?? (req as any).user?.id);
  if (!Number.isSafeInteger(value) || value <= 0) throw Object.assign(new Error("请先登录"), { status: 401, code: "SESSION_REQUIRED" });
  return value;
}
export function humanActor(req: Request): TrustedActor {
  return { id: "human:" + requestUserId(req), kind: "human" };
}
export function sendProjectContentError(res: Response, error: unknown): Response {
  if (error instanceof z.ZodError) return res.status(400).send({ code: "INVALID_INPUT", message: "参数不完整或格式错误", errors: error.issues.map((i) => i.message) });
  if (error instanceof ProjectContentError || error instanceof CreativeWorkspaceError) {
    const status = { INVALID_INPUT: 400, NOT_FOUND: 404, PROJECT_MISMATCH: 403, VERSION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, ACTIVE_TASK: 409, LOCKED: 423 }[error.code];
    return res.status(status).send({ code: error.code, message: error.message });
  }
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  if ([400, 401, 403, 404, 409].includes(Number(value?.status))) return res.status(Number(value.status)).send({ code: value.code ?? Number(value.status), message: value.message ?? "操作未获授权" });
  return res.status(500).send({ code: "INTERNAL_ERROR", message: "内容操作失败" });
}
