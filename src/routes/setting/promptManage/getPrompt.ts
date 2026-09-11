import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { listManagedPrompts } from "@/services/promptRegistry";
import { promptPaths, sendPromptError } from "./_shared";
export default express.Router().post("/", async (_req, res) => {
  try {
    const entries = (await listManagedPrompts(u.db, promptPaths())).filter(p => p.group === "common");
    return res.send(success(entries.map(p => ({ ...p, type: p.commonType, data: p.content, useData: p.customized ? p.content : null }))));
  } catch (err) { return sendPromptError(res, err); }
});
