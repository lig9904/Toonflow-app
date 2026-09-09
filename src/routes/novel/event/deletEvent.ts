import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { deleteNovelEvent } from "@/services/novelEventWorkspace";
import { novelEventActor, novelEventUserId, sendNovelEventError } from "@/services/novelEventWorkspace/http";
import { requireProjectAccess } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    await requireProjectAccess(u.db, novelEventUserId(req), req.body?.projectId, "edit");
    return res.send(success(await deleteNovelEvent(u.db, req.body, novelEventActor(req))));
  } catch (error) { return sendNovelEventError(res, error); }
});
