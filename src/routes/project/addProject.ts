import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { createProject, listConfigurationDirectories, loadEnabledProjectModels } from "@/services/projectContent";
import { humanActor, requestUserId, sendProjectContentError } from "@/services/projectContent/http";
import { requireTeamRole } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    const userId = requestUserId(req);
    await requireTeamRole(u.db, userId, ["admin", "editor"]);
    const metadata = async () => ({
      models: await loadEnabledProjectModels(u.db, (vendorId) => u.vendor.getModelList(vendorId)),
      artStyles: listConfigurationDirectories(u.getPath(["skills", "art_skills"])),
      directorManuals: listConfigurationDirectories(u.getPath(["skills", "story_skills"])),
    });
    return res.send(success(await createProject(u.db, req.body, userId, humanActor(req), metadata)));
  } catch (error) { return sendProjectContentError(res, error); }
});
