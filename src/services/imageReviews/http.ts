import type { Knex } from "knex";
import type { Request, Response } from "express";
import { z } from "zod";
import { success } from "../../lib/responseFormat";
import { requireProductionOwner, sendProductionError } from "../productionHttp";
import { ImageReviewError, type ImageReviewService } from ".";

const scope = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive().optional() });
export function createImageReviewHandlers(db: Knex, service: ImageReviewService) {
  const wrap = (action: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { await action(req, res); }
    catch (error) {
      if (error instanceof ImageReviewError) return res.status(error.status).json({ code: "IMAGE_REVIEW_ERROR", message: error.message });
      return sendProductionError(res, error);
    }
  };
  const authorize = async (req: Request, projectId: number, scriptId?: number) => {
    const actor = await requireProductionOwner(req, projectId, db);
    if (scriptId != null && !(await db("o_script").where({ id: scriptId, projectId }).first())) throw new ImageReviewError("剧集不属于当前项目", 404);
    return Number(String(actor.id).replace(/^human:/, ""));
  };
  return {
    listImageReviews: wrap(async (req, res) => {
      const input = scope.extend({ jobId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(500).optional(), includeCurrent: z.boolean().optional(), targetKind: z.enum(["asset", "storyboard"]).optional(), targetIds: z.array(z.number().int().positive()).max(500).optional() }).strict().parse(req.body);
      await authorize(req, input.projectId, input.scriptId);
      const reviews = await service.list(input);
      const current = input.includeCurrent ? await service.current(input) : undefined;
      return res.send(success({ reviews, ...(current ? { current } : {}) }));
    }),
    reviewImage: wrap(async (req, res) => {
      const input = scope.extend({ jobId: z.number().int().positive() }).strict().parse(req.body);
      const actorId = await authorize(req, input.projectId, input.scriptId);
      const review = await service.enqueue({ ...input, actorId });
      // The HTTP response does not wait on the model or require a human confirmation.
      return res.send(success({ review }));
    }),
  };
}
