import express from "express";
import u from "@/utils";
import { readTaskList } from "@/services/taskOverview";
import { sendCreativeWorkspaceError } from "@/services/creativeWorkspace/http";

export default express.Router().post("/", async (req, res) => {
  try { return res.send({ code: 200, data: await readTaskList(u.db, Number((req as any).teamPrincipal?.id ?? (req as any).user?.id), req.body) }); }
  catch (error) { return sendCreativeWorkspaceError(res, error); }
});
