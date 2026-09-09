import type { Knex } from "knex";
import type { Request, Response } from "express";
import { z, ZodError } from "zod";
import { ProductionStateService, ProductionStateError, type TrustedActor } from "./productionState";
import { ProductionFlowError, addProductionStoryboards, readProductionFlow } from "./productionFlow";
import { notifyProductionChange } from "./productionEvents";
import { success } from "../lib/responseFormat";
import { VideoJobError } from "./videoJobs";
import { ProductionAssetError } from "./productionAssets";
import { ProductionImageError } from "./productionImages";
import replaceUrl from "../utils/replaceUrl";
import { requireProjectAccess, TeamSecurityError } from "./team";
import { getRouteAuthorization } from "./team/authorization";
import { resolveImageFlowOwner, ImageFlowWorkspaceError } from "./imageFlowWorkspace";
import { assertImageMediaProject, MediaOwnershipError } from "../lib/mediaOwnership";

export async function requireProductionOwner(req: Request, projectId: number, db: Knex): Promise<TrustedActor> {
  const userId = Number((req as Request & { user?: { id?: number } }).user?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new ProductionFlowError("请先登录", 401);
  const exactPath = (req.originalUrl || req.path || "").split("?")[0].replace(/\/$/, "");
  const operation = getRouteAuthorization(req.method, exactPath);
  // Retain this export for existing route handlers; authorization is now shared-team and operation-specific.
  await requireProjectAccess(db, userId, projectId, operation?.action ?? "edit");
  return { id: `human:${userId}`, kind: "human" };
}
export function sendProductionError(res: Response, error: unknown) {
  if (error instanceof ImageFlowWorkspaceError || error instanceof MediaOwnershipError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "PROJECT_MISMATCH" ? 403 : error.code === "INVALID_INPUT" ? 400 : 409;
    return res.status(status).json({ code: error.code, message: error.message });
  }
  if (error instanceof TeamSecurityError) return res.status(error.status).json({ code: error.code, message: error.message });
  if (error instanceof ProductionAssetError || error instanceof ProductionImageError) return res.status(error.status).json({ code:error.status, message:error.message });
  if (error instanceof ZodError) return res.status(400).json({ code: "INVALID_INPUT", message: "参数错误", errors: error.issues.map((i) => i.message) });
  if (error instanceof VideoJobError) {
    const status = { CONFLICT:409, NOT_FOUND:404, PROJECT_MISMATCH:404, INVALID_INPUT:400, UNSUPPORTED_PROVIDER:422 }[error.code];
    return res.status(status).json({ code:error.code, message:error.message });
  }
  if (error instanceof ProductionStateError) {
    const status = { NOT_FOUND: 404, PROJECT_MISMATCH: 404, VERSION_CONFLICT: 409, LOCKED: 423, FORBIDDEN: 403, INVALID_INPUT: 400 }[error.code];
    return res.status(status).json({ code: error.code, message: error.message });
  }
  if (error instanceof ProductionFlowError) return res.status(error.status).json({ code: error.status, message: error.message });
  if (error instanceof Error && /storyboard is locked/.test(error.message)) return res.status(423).json({ code: "LOCKED", message: "该分镜已锁定" });
  if (error instanceof Error && /SQLITE_BUSY/.test(error.message)) return res.status(409).json({ code: "VERSION_CONFLICT", message: "数据正在更新，请重新载入" });
  return res.status(500).json({ code: "INTERNAL_ERROR", message: "制作状态更新失败" });
}
const projectId = z.coerce.number().int().positive();
const id = z.number().int().positive();
const expectedVersion = z.number().int().nonnegative();
const entity = z.object({ projectId, id }).strict();
const edit = entity.extend({ expectedVersion, prompt: z.string().max(100000), videoDesc: z.string().max(100000) });
const review = entity.extend({ expectedVersion, reviewState: z.enum(["draft", "pending", "approved", "revision"]) });
const lock = entity.extend({ expectedVersion, locked: z.boolean() });
const newStoryboard = z.object({
  prompt: z.string(), duration: z.number().finite().nonnegative(), track: z.string(), videoDesc: z.string(),
  shouldGenerateImage: z.union([z.literal(0), z.literal(1)]), associateAssetsIds: z.array(id),
  state: z.string().optional(), src: z.string().nullable().optional(),
});
const add = z.object({ projectId, scriptId: z.number().int().positive(), data: z.array(newStoryboard).min(1).max(100) }).strict();

async function removeUnusedFlow(trx: Knex.Transaction, projectId: number, flowIdValue: unknown) {
  const flowId = Number(flowIdValue);
  if (!Number.isSafeInteger(flowId) || flowId <= 0 || await trx("o_storyboard").where({ flowId }).first() || await trx("o_assets").where({ flowId }).first()) return;
  await trx("o_imageFlow").where({ id: flowId }).delete();
  if (await trx.schema.hasTable("ext_image_flow_owners")) await trx("ext_image_flow_owners").where({ flowId, projectId }).delete();
  if (await trx.schema.hasTable("ext_creative_state")) await trx("ext_creative_state").where({ entityType: "imageFlow", entityId: flowId, projectId }).delete();
}

export function createProductionHandlers(db: Knex, getUrl: (path: string) => Promise<string>) {
  const service = new ProductionStateService(db);
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { await fn(req, res); } catch (error) { sendProductionError(res, error); }
  };
  const changed = (result: Awaited<ReturnType<ProductionStateService["getStoryboardState"]>>) => {
    notifyProductionChange({ projectId: result.state.projectId, scriptId: Number(result.storyboard.scriptId), storyboardId: result.state.entityId });
    return result;
  };
  return {
    updateStoryboardUrl: wrap(async (req, res) => {
      const data = entity.extend({ expectedVersion, url: z.string(), flowId: id }).parse(req.body);
      const actor = await requireProductionOwner(req, data.projectId, db);
      await service.guardStoryboardMutations({ projectId: data.projectId, storyboardIds: [data.id],
        expectedVersions: { [data.id]: data.expectedVersion }, actor, mutate: async (trx, contexts) => {
          const owner = await resolveImageFlowOwner(trx, data.flowId);
          if (owner.projectId !== data.projectId || owner.scriptId !== Number(contexts[0].storyboard.scriptId)) throw new ProductionFlowError("图片工作流不属于当前项目和剧集", 403);
          if (await trx("o_assets").where({ flowId: data.flowId }).first() || await trx("o_storyboard").where({ flowId: data.flowId }).whereNot({ id: data.id }).first()) throw new ProductionFlowError("图片工作流已绑定其他资源", 409);
          const filePath = await assertImageMediaProject(trx, data.projectId, data.url);
          await trx("o_storyboard").where({ id: data.id }).update({ filePath, flowId: data.flowId,
            state: "已完成", shouldGenerateImage: data.url ? 1 : 0 });
        },
      });
      res.send(success(changed(await service.getStoryboardState(data.projectId, data.id))));
    }),
    removeFrame: wrap(async (req, res) => {
      const data = entity.extend({ expectedVersion }).parse(req.body);
      const actor = await requireProductionOwner(req, data.projectId, db);
      const scriptId = await service.guardStoryboardMutations({ projectId: data.projectId, storyboardIds: [data.id],
        expectedVersions: { [data.id]: data.expectedVersion }, actor, mutate: async (trx, contexts) => {
          const row = contexts[0].storyboard;
          await trx("o_assets2Storyboard").where({ storyboardId: data.id }).delete();
          await trx("o_storyboard").where({ id: data.id }).delete();
          await removeUnusedFlow(trx, data.projectId, row.flowId);
          if (row.trackId && !(await trx("o_storyboard").where({ trackId: row.trackId }).first())) await trx("o_videoTrack").where({ id: row.trackId, projectId: data.projectId }).delete();
          return Number(row.scriptId);
        },
      });
      notifyProductionChange({ projectId: data.projectId, scriptId, storyboardId: data.id });
      res.send(success());
    }),
    batchDelete: wrap(async (req, res) => {
      const data = z.object({ projectId, ids: z.array(id).min(1).max(1000), expectedVersions: z.record(z.string(), expectedVersion) }).strict().parse(req.body);
      const actor = await requireProductionOwner(req, data.projectId, db);
      const scripts = await service.guardStoryboardMutations({ projectId: data.projectId, storyboardIds: data.ids,
        expectedVersions: data.expectedVersions, actor, mutate: async (trx, contexts) => {
          await trx("o_assets2Storyboard").whereIn("storyboardId", data.ids).delete();
          await trx("o_storyboard").whereIn("id", data.ids).delete();
          for (const { storyboard: row } of contexts) {
            await removeUnusedFlow(trx, data.projectId, row.flowId);
            if (row.trackId && !(await trx("o_storyboard").where({ trackId: row.trackId }).first())) await trx("o_videoTrack").where({ id: row.trackId, projectId: data.projectId }).delete();
          }
          return [...new Set(contexts.map((ctx) => Number(ctx.storyboard.scriptId)))];
        },
      });
      for (const scriptId of scripts) notifyProductionChange({ projectId: data.projectId, scriptId });
      res.send(success());
    }),
    getState: wrap(async (req, res) => {
      const data = entity.parse(req.body);
      await requireProductionOwner(req, data.projectId, db);
      res.send(success(await service.getStoryboardState(data.projectId, data.id)));
    }),
    editStoryboardInfo: wrap(async (req, res) => {
      const data = edit.parse(req.body);
      const actor = await requireProductionOwner(req, data.projectId, db);
      res.send(success(changed(await service.updateStoryboardContent({ projectId: data.projectId, storyboardId: data.id,
        expectedVersion: data.expectedVersion, actor, patch: { prompt: data.prompt, videoDesc: data.videoDesc } }))));
    }),
    setReviewState: wrap(async (req, res) => {
      const data = review.parse(req.body);
      const actor = await requireProductionOwner(req, data.projectId, db);
      res.send(success(changed(await service.setReviewState({ ...data, storyboardId: data.id, actor }))));
    }),
    setLock: wrap(async (req, res) => {
      const data = lock.parse(req.body);
      const actor = await requireProductionOwner(req, data.projectId, db);
      const input = { ...data, storyboardId: data.id, actor };
      res.send(success(changed(await (data.locked ? service.acquireLock(input) : service.releaseLock(input)))));
    }),
    batchAddStoryboardInfo: wrap(async (req, res) => {
      const data = add.parse(req.body);
      await requireProductionOwner(req, data.projectId, db);
      await addProductionStoryboards(db, data.projectId, data.scriptId, data.data);
      notifyProductionChange({ projectId: data.projectId, scriptId: data.scriptId });
      res.send(success((await readProductionFlow(db, data.projectId, data.scriptId, getUrl)).storyboard));
    }),
  };
}
