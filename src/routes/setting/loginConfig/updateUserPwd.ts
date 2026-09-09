import express from "express";
import u from "@/utils";
import { updateAccountPassword } from "@/services/applicationSession";
import { getTeamUser } from "@/services/team";
import { sendCreativeWorkspaceError } from "@/services/creativeWorkspace/http";

export default express.Router().post("/", async (req, res) => {
  try {
    const principal = await getTeamUser(u.db, Number((req as any).user?.id));
    await updateAccountPassword(u.db, principal, req.body);
    return res.send({ code: 200, data: { reauthenticate: true }, message: "密码已更新，请重新登录" });
  } catch (error) { return sendCreativeWorkspaceError(res, error); }
});
