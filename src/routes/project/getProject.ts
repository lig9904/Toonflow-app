import express from "express";
import u from "@/utils";
import { listProjects } from "@/services/projectContent";
import { legacyArrayResponse, requestUserId, sendProjectContentError } from "@/services/projectContent/http";

export default express.Router().post("/", async (req, res) => {
  try { return res.send(legacyArrayResponse(await listProjects(u.db, requestUserId(req)))); }
  catch (error) { return sendProjectContentError(res, error); }
});
