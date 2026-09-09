import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { deleteNovel, deleteNovels } from "@/services/projectContent";
import { humanActor, requestUserId, sendProjectContentError } from "@/services/projectContent/http";
import { requireProjectAccess } from "@/services/team";

export default express.Router().post("/", async (req, res) => {
  try {
    await requireProjectAccess(u.db, requestUserId(req), req.body?.projectId, "delete");
    const result = Array.isArray(req.body?.items)
      ? await deleteNovels(u.db, req.body, humanActor(req))
      : await deleteNovel(u.db, req.body, humanActor(req));
    return res.send(success(result));
  } catch (error) { return sendProjectContentError(res, error); }
});
