import express from "express";
import u from "@/utils";
import { recoverMediaJob, MediaJobControlError } from "@/services/mediaJobControl";

export default express.Router().post("/", async (req, res) => {
  try {
    const userId = Number((req as any).teamPrincipal?.id ?? (req as any).user?.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(401).send({ code: "SESSION_REQUIRED", message: "请先登录" });
    return res.send({ code: 200, data: await recoverMediaJob(u.db, req.body, { id: `human:${userId}` }) });
  } catch (error) {
    if (error instanceof MediaJobControlError) return res.status(error.status).send({ code: error.code, message: error.message });
    return res.status(500).send({ code: "INTERNAL_ERROR", message: "媒体任务恢复失败" });
  }
});
