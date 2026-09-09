import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { requireProjectAccess } from "@/services/team";
import { presentImageFlow, readImageFlow } from "@/services/imageFlowWorkspace";
import { imageFlowUserId, sendImageFlowError } from "@/services/imageFlowWorkspace/http";

export default express.Router().post("/", async (req, res) => {
  try {
    const projectId = Number(req.body?.projectId);
    await requireProjectAccess(u.db, imageFlowUserId(req), projectId, "read");
    const flow = await readImageFlow(u.db, req.body);
    return res.status(200).send(success(await presentImageFlow(flow, (path) => u.oss.getSmallImageUrl(path))));
  } catch (error) {
    return sendImageFlowError(res, error);
  }
});
