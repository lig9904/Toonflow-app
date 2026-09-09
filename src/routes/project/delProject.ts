import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { deleteProject } from "@/services/projectContent";
import { humanActor, requestUserId, sendProjectContentError } from "@/services/projectContent/http";
import { requireTeamRole } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    await requireTeamRole(u.db, requestUserId(req), "admin");
    return res.send(success(await deleteProject(u.db, req.body, humanActor(req))));
  } catch (error) { return sendProjectContentError(res, error); }
});
