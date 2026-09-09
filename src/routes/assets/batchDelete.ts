import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { batchDeleteAssets } from "@/services/assetWorkspace";
import { actor, send, storage, userId } from "@/services/assetWorkspace/http";
import { requireProjectAccess } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    await requireProjectAccess(u.db, userId(req), req.body?.projectId, "delete");
    return res.send(success(await batchDeleteAssets(u.db, req.body, actor(req), storage(u.oss))));
  } catch (error) {
    return send(res, error);
  }
});
