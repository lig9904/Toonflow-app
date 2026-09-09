import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { startNovelEventRun } from "@/services/novelEventWorkspace";
import { novelEventUserId, sendNovelEventError } from "@/services/novelEventWorkspace/http";
import { requireProjectAccess } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    const userId = novelEventUserId(req);
    await requireProjectAccess(u.db, userId, req.body?.projectId, "edit");
    return res.send(success(await startNovelEventRun(u.db, req.body, userId)));
  } catch (error) { return sendNovelEventError(res, error); }
});
