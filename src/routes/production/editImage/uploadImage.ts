import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { requireProjectAccess } from "@/services/team";
import { uploadImageFlowMedia } from "@/services/imageFlowWorkspace";
import { imageFlowActor, imageFlowUserId, sendImageFlowError } from "@/services/imageFlowWorkspace/http";

export default express.Router().post("/", async (req, res) => {
  try {
    const projectId = Number(req.body?.projectId);
    await requireProjectAccess(u.db, imageFlowUserId(req), projectId, "edit");
    const result = await uploadImageFlowMedia(u.db, req.body, imageFlowActor(req), {
      write: (path, data) => u.oss.writeFile(path, data),
    });
    return res.status(200).send(success({ ...result, url: await u.oss.getSmallImageUrl(result.filePath) }));
  } catch (error) {
    return sendImageFlowError(res, error);
  }
});
