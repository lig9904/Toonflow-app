import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { listConfigurationDirectories, loadEnabledProjectModels, updateProject } from "@/services/projectContent";
import { humanActor, requestUserId, sendProjectContentError } from "@/services/projectContent/http";
import { requireProjectAccess } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    await requireProjectAccess(u.db, requestUserId(req), req.body?.id, "edit");
    const metadata = async () => ({
      models: await loadEnabledProjectModels(u.db, (vendorId) => u.vendor.getModelList(vendorId)),
      artStyles: listConfigurationDirectories(u.getPath(["skills", "art_skills"])),
      directorManuals: listConfigurationDirectories(u.getPath(["skills", "story_skills"])),
    });
    return res.send(success(await updateProject(u.db, req.body, humanActor(req), metadata)));
  } catch (error) { return sendProjectContentError(res, error); }
});
