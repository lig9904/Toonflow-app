import express from "express";
import u from "@/utils";
import { listScripts } from "@/services/projectContent";
import { requestUserId, scriptListResponse, sendProjectContentError } from "@/services/projectContent/http";
import { requireProjectAccess } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    await requireProjectAccess(u.db, requestUserId(req), req.body?.projectId, "read");
    const result = await listScripts(u.db, Number(req.body.projectId), req.body.name);
    return res.send(scriptListResponse(result.scripts, result.workspaceVersion));
  } catch (error) { return sendProjectContentError(res, error); }
});
