import express from "express";
import u from "@/utils";
import { createScriptWorkspaceHandlers } from "@/services/creativeWorkspace/http";
import { requireProjectAccess } from "@/services/team";

const handlers = createScriptWorkspaceHandlers(u.db, async (req, projectId, action) => {
  const userId = Number((req as any).user?.id);
  await requireProjectAccess(u.db, userId, projectId, action);
  return { id: `human:${userId}`, kind: "human" };
});
export default express.Router().post("/", handlers.get);
