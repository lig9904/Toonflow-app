import type { Request, Response } from "express";
import u from "@/utils";
import { PromptRegistryError, promptDefinitions } from "@/services/promptRegistry";
export const promptPaths = () => ({ skillsDir: u.getPath("skills"), modelPromptDir: u.getPath("modelPrompt") });
export function promptActor(req: Request) {
  const id = Number((req as any).teamPrincipal?.id ?? (req as any).user?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("需要已认证会话"), { status: 401, code: "SESSION_REQUIRED" });
  return { id: `human:${id}`, kind: "human" };
}
export async function promptKey(req: Request): Promise<string> {
  if (typeof req.body?.key === "string") return req.body.key;
  const id = req.body?.id;
  if (!Number.isSafeInteger(id) || id <= 0) throw new PromptRegistryError("INVALID_INPUT", "需要提示词 key 或有效旧版 id");
  const legacy = await u.db("o_prompt").where({ id }).first();
  const found = promptDefinitions.find(p => p.commonType === legacy?.type);
  if (!found) throw new PromptRegistryError("NOT_FOUND", "提示词不存在");
  return found.key;
}
export function sendPromptError(res: Response, err: unknown) {
  if (err instanceof PromptRegistryError) return res.status(({ INVALID_INPUT: 400, NOT_FOUND: 404, VERSION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, DEFAULT_UNAVAILABLE: 503 })[err.code]).send({ code: err.code, message: err.message, currentVersion: err.currentVersion });
  if ((err as any)?.status === 401) return res.status(401).send({ code: "SESSION_REQUIRED", message: "需要已认证会话" });
  return res.status(500).send({ code: "PROMPT_OPERATION_FAILED", message: "提示词操作失败" });
}
export function writeInput(req: Request) {
  return { expectedVersion: req.body?.expectedVersion, idempotencyKey: req.body?.idempotencyKey, actor: promptActor(req) };
}
