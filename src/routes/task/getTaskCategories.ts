import express from "express";
import u from "@/utils";
import { readTaskCategories } from "@/services/taskOverview";
import { sendCreativeWorkspaceError } from "@/services/creativeWorkspace/http";

export default express.Router().post("/", async (req, res) => {
  try { return res.send({ code: 200, data: await readTaskCategories(u.db, Number((req as any).teamPrincipal?.id ?? (req as any).user?.id)) }); }
  catch (error) { return sendCreativeWorkspaceError(res, error); }
});
