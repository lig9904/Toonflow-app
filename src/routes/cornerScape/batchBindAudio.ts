import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { startAudioMatchRun } from "@/services/roleAudioWorkspace";
import { sendRoleAudioError, userId } from "@/services/roleAudioWorkspace/http";
const router = express.Router();

export default router.post("/", async (req, res) => {
  try {
    return res.send(success(await startAudioMatchRun(u.db, req.body, userId(req))));
  } catch (error) { return sendRoleAudioError(res, error); }
});
