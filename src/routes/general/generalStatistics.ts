import express from "express";
import u from "@/utils";
import { z } from "zod";
import { readProjectStatistics } from "@/services/taskOverview";
import { sendCreativeWorkspaceError } from "@/services/creativeWorkspace/http";

export default express.Router().post("/", async (req, res) => {
  try {
    const { projectId } = z.object({ projectId: z.number().int().positive() }).strict().parse(req.body);
    return res.send({ code: 200, data: await readProjectStatistics(u.db, Number((req as any).user?.id), projectId) });
  } catch (error) { return sendCreativeWorkspaceError(res, error); }
});
