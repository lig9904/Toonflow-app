import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { requireProjectAccess } from "@/services/team";
import { createImageFlow } from "@/services/imageFlowWorkspace";
import { imageFlowActor, imageFlowUserId, sendImageFlowError } from "@/services/imageFlowWorkspace/http";

export default express.Router().post("/", async (req, res) => {
  try {
    const projectId = Number(req.body?.projectId);
    await requireProjectAccess(u.db, imageFlowUserId(req), projectId, "edit");
    return res.status(200).send(success(await createImageFlow(u.db, req.body, imageFlowActor(req))));
  } catch (error) {
    return sendImageFlowError(res, error);
  }
});
