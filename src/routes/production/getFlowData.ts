import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { readProductionFlow } from "@/services/productionFlow";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
const schema = z.object({ projectId: z.coerce.number().int().positive(), episodesId: z.coerce.number().int().positive() });
export default express.Router().post("/", async (req, res) => {
  try {
    const { projectId, episodesId } = schema.parse(req.body);
    await requireProductionOwner(req, projectId, u.db);
    res.send(success(await readProductionFlow(u.db, projectId, episodesId, (path) => u.oss.getSmallImageUrl(path))));
  } catch (error) { sendProductionError(res, error); }
});
