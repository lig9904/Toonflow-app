import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { updateAudioAsset } from "@/services/assetWorkspace";
import { actor, send, storage, userId } from "@/services/assetWorkspace/http";
import { requireProjectAccess } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    await requireProjectAccess(u.db, userId(req), req.body?.projectId, "edit");
    const body = {
      ...req.body,
      ...(Array.isArray(req.body?.assetsItem)
        ? { assetsItem: req.body.assetsItem.map((item: any) => ({ ...item, ...(item.src ? { src: u.replaceUrl(item.src) } : {}) })) }
        : {}),
    };
    return res.send(success(await updateAudioAsset(u.db, body, actor(req), storage(u.oss))));
  } catch (error) {
    return send(res, error);
  }
});
