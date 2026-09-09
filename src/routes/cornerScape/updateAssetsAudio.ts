import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { saveRoleAudioBinding } from "@/services/roleAudioWorkspace";
import { actor, sendRoleAudioError } from "@/services/roleAudioWorkspace/http";
const router = express.Router();

export default router.post("/", async (req, res) => {
  try {
    const body = { ...req.body, roleAssetId: req.body?.roleAssetId ?? req.body?.assetsId };
    return res.send(success(await saveRoleAudioBinding(u.db, body, actor(req))));
  } catch (error) { return sendRoleAudioError(res, error); }
});
