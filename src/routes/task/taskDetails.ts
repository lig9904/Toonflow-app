import express from "express";
import u from "@/utils";
import { readTaskDetail } from "@/services/taskOverview";
import { sendCreativeWorkspaceError } from "@/services/creativeWorkspace/http";
import { mediaJobRecoveryCapability } from "@/services/mediaJobControl";
import { requireProjectAccess, TeamSecurityError } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    const userId = Number((req as any).teamPrincipal?.id ?? (req as any).user?.id);
    const detail = await readTaskDetail(u.db, userId, req.body?.taskId);
    if (detail.source === "image" || detail.source === "video") {
      const recovery = await mediaJobRecoveryCapability(u.db, detail.source, Number(detail.sourceId), detail.projectId);
      try { await requireProjectAccess(u.db, userId, detail.projectId, "edit"); }
      catch (error) {
        if (!(error instanceof TeamSecurityError)) throw error;
        recovery.canRecover = false;
        recovery.recoveryActions = [];
      }
      return res.send({ code: 200, data: { ...detail, recovery } });
    }
    return res.send({ code: 200, data: detail });
  }
  catch (error) { return sendCreativeWorkspaceError(res, error); }
});
