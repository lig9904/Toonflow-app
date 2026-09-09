import express, { type Request, type Response } from "express";
import { z } from "zod";
import { defaultBuiltinRunLimits, builtinAgentTypes, type BuiltinRunView } from "./contracts";
import { BuiltinAgentRuntime, BuiltinRuntimeError } from "../builtinAgentRuntime";

const id = z.number().int().positive();
const limitsSchema = z.object({
  maxModelCalls: z.number().int().min(1).max(50).optional(),
  maxToolSteps: z.number().int().min(1).max(500).optional(),
  maxOutputTokens: z.number().int().min(384).max(64000).optional(),
  maxImageGenerations: z.number().int().min(0).max(100).optional(),
  maxVideoGenerations: z.number().int().min(0).max(100).optional(),
}).strict();
const startSchema = z.object({
  agentType: z.enum(builtinAgentTypes), projectId: id, scriptId: id.nullable().optional(),
  prompt: z.string().trim().min(1).max(100000),
  idempotencyKey: z.string().min(8).max(150).regex(/^[\w:.-]+$/),
  limits: limitsSchema.optional(),
  thinkLevel: z.number().int().min(0).max(3).optional(),
}).strict();

export interface BuiltinHttpDependencies {
  runtime: BuiltinAgentRuntime;
  userId(req: Request): Promise<number>;
  authorize(userId: number, projectId: number, action: "read" | "edit", scriptId?: number | null): Promise<void>;
}

export function sendBuiltinError(res: Response, error: unknown): Response {
  if (error instanceof z.ZodError) return res.status(400).send({ code: "INVALID_INPUT", message: "任务参数不完整或格式错误" });
  if (error instanceof BuiltinRuntimeError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : error.code === "INVALID_INPUT" ? 400 : 409;
    return res.status(status).send({ code: error.code, message: error.message });
  }
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  if (value && [401, 403, 404, 409, 423].includes(Number(value.status))) {
    return res.status(Number(value.status)).send({ code: value.code ?? Number(value.status), message: value.message ?? "无权操作此任务" });
  }
  return res.status(500).send({ code: "INTERNAL_ERROR", message: "内置 Agent 任务操作失败" });
}

/** Mounted behind authenticated application middleware. Reading progress never schedules work. */
export function createBuiltinAgentRouter(deps: BuiltinHttpDependencies): express.Router {
  const router = express.Router();
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { await fn(req, res); } catch (error) { sendBuiltinError(res, error); }
  };
  const authorizeRun = async (req: Request, run: BuiltinRunView, action: "read" | "edit") => {
    const userId = await deps.userId(req);
    if (run.projectId == null) throw new BuiltinRuntimeError("FORBIDDEN", "任务尚未绑定项目");
    await deps.authorize(userId, run.projectId, action, run.scriptId);
    return userId;
  };
  router.post("/start", handle(async (req, res) => {
    const input = startSchema.parse(req.body);
    const requestedBy = await deps.userId(req);
    await deps.authorize(requestedBy, input.projectId, "edit", input.scriptId);
    if (input.agentType === "productionAgent" && input.scriptId == null) throw new BuiltinRuntimeError("INVALID_INPUT", "制作任务需要指定剧集");
    const { thinkLevel, ...runInput } = input;
    const result = await deps.runtime.create({
      ...runInput,
      requestedBy,
      limits: { ...defaultBuiltinRunLimits, ...input.limits },
      ...(thinkLevel === undefined ? {} : { intent: { thinkLevel } }),
    });
    res.send({ code: 200, data: result });
  }));
  router.post("/list", handle(async (req, res) => {
    const input = z.object({ projectId: id, scriptId: id.nullable().optional(), limit: z.number().int().min(1).max(100).optional() }).strict().parse(req.body);
    const userId = await deps.userId(req);
    await deps.authorize(userId, input.projectId, "read", input.scriptId);
    res.send({ code: 200, data: { runs: await deps.runtime.list(input) } });
  }));
  router.post("/get", handle(async (req, res) => {
    const input = z.object({ runId: z.string().uuid(), afterSequence: z.number().int().nonnegative().optional() }).strict().parse(req.body);
    const run = await deps.runtime.get(input.runId);
    await authorizeRun(req, run, "read");
    const events = await deps.runtime.events(run.id, input.afterSequence, 200);
    // Advance only to delivered events, not to an unread event beyond this page.
    res.send({ code: 200, data: { run, events, nextSequence: events.at(-1)?.sequence ?? input.afterSequence ?? 0 } });
  }));
  router.post("/control", handle(async (req, res) => {
    const input = z.object({ runId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), action: z.enum(["pause", "resume", "cancel", "takeover"]), reason: z.string().max(4000).optional(), answer: z.string().max(4000).optional() }).strict().parse(req.body);
    const run = await deps.runtime.get(input.runId);
    const userId = await authorizeRun(req, run, "edit");
    const result = await deps.runtime.control(run.id, input.expectedVersion, input.action, input.answer ?? input.reason, userId);
    res.send({ code: 200, data: { run: result } });
  }));
  return router;
}
