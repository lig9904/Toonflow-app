import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { NovelEventWorkspaceError, readNovelEventStates } from "@/services/novelEventWorkspace";
import { novelEventUserId, sendNovelEventError } from "@/services/novelEventWorkspace/http";
import { requireProjectAccess } from "@/services/team";

const inputSchema = z.object({ projectId: z.number().int().positive(), ids: z.array(z.number().int().positive()).min(1).max(2000) }).strict();

export default express.Router().post("/", async (req, res) => {
  try {
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) throw new NovelEventWorkspaceError("INVALID_INPUT", parsed.error.issues.map((issue) => issue.message).join("; "));
    const input = parsed.data;
    await requireProjectAccess(u.db, novelEventUserId(req), input.projectId, "read");
    return res.send(success(await readNovelEventStates(u.db, input.projectId, input.ids)));
  } catch (error) { return sendNovelEventError(res, error); }
});
