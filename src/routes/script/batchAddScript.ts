import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { createScripts } from "@/services/projectContent";
import { humanActor, requestUserId, sendProjectContentError } from "@/services/projectContent/http";
import { requireProjectAccess } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    await requireProjectAccess(u.db, requestUserId(req), req.body?.projectId, "edit");
    return res.send(success(await createScripts(u.db, req.body, humanActor(req))));
  } catch (error) { return sendProjectContentError(res, error); }
});
