import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { deleteScripts } from "@/services/projectContent";
import { humanActor, requestUserId, sendProjectContentError } from "@/services/projectContent/http";
import { requireProjectAccess } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    await requireProjectAccess(u.db, requestUserId(req), req.body?.projectId, "delete");
    return res.send(success(await deleteScripts(u.db, req.body, humanActor(req))));
  } catch (error) { return sendProjectContentError(res, error); }
});
