import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { createNovels } from "@/services/projectContent";
import { humanActor, requestUserId, sendProjectContentError } from "@/services/projectContent/http";
import { requireProjectAccess } from "@/services/team";
import { NovelEventWorkspaceError, startNovelEventRun } from "@/services/novelEventWorkspace";
import { sendNovelEventError } from "@/services/novelEventWorkspace/http";

export default express.Router().post("/", async (req, res) => {
  try {
    await requireProjectAccess(u.db, requestUserId(req), req.body?.projectId, "edit");
    const result = await createNovels(u.db, req.body, humanActor(req));
    if (!result.processEvents) return res.send(success(result));
    const baseKey = String(req.body.idempotencyKey);
    const runKey = baseKey.length <= 143 ? `${baseKey}:events` : `novel-events:${baseKey.slice(-120)}`;
    const eventRun = await startNovelEventRun(u.db, {
      projectId: Number(req.body.projectId),
      novelIds: result.novels.map((novel) => novel.id),
      expectedVersions: Object.fromEntries(result.novels.map((novel) => [String(novel.id), novel.version])),
      idempotencyKey: runKey,
      concurrentCount: 2,
    }, requestUserId(req));
    return res.send(success({ ...result, eventRun }));
  } catch (error) { return error instanceof NovelEventWorkspaceError ? sendNovelEventError(res, error) : sendProjectContentError(res, error); }
});
