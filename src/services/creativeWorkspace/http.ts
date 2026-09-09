import type { Knex } from "knex";
import type { Request, Response } from "express";
import { z } from "zod";
import { success } from "../../lib/responseFormat";
import type { TrustedActor } from "../productionState";
import { CreativeWorkspaceError, readScriptWorkspace, saveScriptWorkspace } from "./index";

type Authorize = (req: Request, projectId: number, action: "read" | "edit") => Promise<TrustedActor>;
const optionalId = z.number().int().positive().optional();
const optionalVersion = z.number().int().nonnegative().optional();
const dataSchema = z.object({
  storySkeleton: z.string().max(2_000_000).optional(),
  adaptationStrategy: z.string().max(2_000_000).optional(),
  version: optionalVersion,
  script: z.array(z.object({
    id: optionalId,
    name: z.string().trim().min(1).max(500).optional(),
    content: z.string().max(2_000_000),
    version: optionalVersion,
    expectedVersion: optionalVersion,
    assets: z.array(z.number().int().positive()).max(10000).optional(),
  }).strict()).max(200).optional(),
}).strict();
const saveSchema = z.object({
  projectId: optionalId,
  id: optionalId,
  agentType: z.literal("scriptAgent").optional(),
  expectedVersion: optionalVersion,
  mutationKey: z.string().min(8).max(150).optional(),
  data: dataSchema,
}).strict();

export function sendCreativeWorkspaceError(res: Response, error: unknown): Response {
  if (error instanceof z.ZodError) return res.status(400).send({ code: "INVALID_INPUT", message: "参数不完整或格式错误", errors: error.issues.map((e) => e.message) });
  if (error instanceof CreativeWorkspaceError) {
    const status = { NOT_FOUND: 404, INVALID_INPUT: 400, PROJECT_MISMATCH: 403, VERSION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409 }[error.code];
    return res.status(status).send({ code: error.code, message: error.message });
  }
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  if (value && [401, 403, 404, 409, 423].includes(Number(value.status))) {
    return res.status(Number(value.status)).send({ code: typeof value.code === "string" ? value.code : Number(value.status), message: typeof value.message === "string" ? value.message : "操作未获授权" });
  }
  return res.status(500).send({ code: "INTERNAL_ERROR", message: "剧本工作区操作失败" });
}

export function createScriptWorkspaceHandlers(db: Knex, authorize: Authorize) {
  const get = async (req: Request, res: Response) => {
    try {
      const input = z.object({ projectId: z.number().int().positive(), agentType: z.literal("scriptAgent") }).strict().parse(req.body);
      await authorize(req, input.projectId, "read");
      const data = await readScriptWorkspace(db, input.projectId);
      return res.send(success({ data, id: data.id, version: data.version }));
    } catch (error) { return sendCreativeWorkspaceError(res, error); }
  };

  const save = async (req: Request, res: Response) => {
    try {
      const input = saveSchema.parse(req.body);
      const cache = input.id != null ? await db("o_agentWorkData").where({ id: input.id, key: "scriptAgent" }).first() : null;
      if (input.id != null && !cache) throw new CreativeWorkspaceError("NOT_FOUND", "工作区不存在");
      const projectId = input.projectId ?? (cache ? Number(cache.projectId) : undefined);
      if (projectId == null) throw new CreativeWorkspaceError("INVALID_INPUT", "缺少项目编号");
      if (cache && Number(cache.projectId) !== projectId) throw new CreativeWorkspaceError("PROJECT_MISMATCH", "工作区不属于当前项目");
      const actor = await authorize(req, projectId, "edit");
      const expectedVersion = input.expectedVersion ?? input.data.version;
      if (expectedVersion == null) throw new CreativeWorkspaceError("VERSION_CONFLICT", "请先读取工作区版本再保存");
      const key = input.mutationKey ?? req.get("Idempotency-Key");
      if (!key) throw new CreativeWorkspaceError("INVALID_INPUT", "保存需要操作编号");
      const current = await readScriptWorkspace(db, projectId);
      const scripts = input.data.script?.map((s) => {
        const name = s.name ?? (s.id != null ? current.script.find((row) => row.id === s.id)?.name : undefined);
        if (!name) throw new CreativeWorkspaceError("INVALID_INPUT", "新剧本必须提供名称");
        return {
          ...(s.id == null ? {} : { id: s.id }),
          ...((s.expectedVersion ?? s.version) == null ? {} : { expectedVersion: s.expectedVersion ?? s.version }),
          name, content: s.content, ...(s.assets == null ? {} : { assets: s.assets }),
        };
      });
      const data = await saveScriptWorkspace(db, {
        projectId, expectedVersion, mutationKey: key, actor,
        ...(input.data.storySkeleton == null ? {} : { storySkeleton: input.data.storySkeleton }),
        ...(input.data.adaptationStrategy == null ? {} : { adaptationStrategy: input.data.adaptationStrategy }),
        ...(scripts == null ? {} : { script: scripts }),
      });
      return res.send(success({ data, id: data.id, version: data.version, createdScriptIds: data.createdScriptIds, replayed: data.replayed }));
    } catch (error) { return sendCreativeWorkspaceError(res, error); }
  };
  return { get, save };
}
