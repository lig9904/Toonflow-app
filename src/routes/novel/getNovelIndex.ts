import express from "express";
import u from "@/utils";
import { readNovelIndex } from "@/services/projectContent";
import { legacyArrayResponse, requestUserId, sendProjectContentError } from "@/services/projectContent/http";
import { requireProjectAccess } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    await requireProjectAccess(u.db, requestUserId(req), req.body?.projectId, "read");
    return res.send(legacyArrayResponse(await readNovelIndex(u.db, Number(req.body.projectId))));
  } catch (error) { return sendProjectContentError(res, error); }
});
