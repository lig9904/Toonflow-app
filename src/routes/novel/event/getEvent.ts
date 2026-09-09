import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { readNovelEvents } from "@/services/novelEventWorkspace";
import { novelEventUserId, sendNovelEventError } from "@/services/novelEventWorkspace/http";
import { requireProjectAccess } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    await requireProjectAccess(u.db, novelEventUserId(req), req.body?.projectId, "read");
    return res.send(success(await readNovelEvents(u.db, req.body)));
  } catch (error) { return sendNovelEventError(res, error); }
});
