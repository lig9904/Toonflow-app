import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { saveManagedPrompt } from "@/services/promptRegistry";
import { promptPaths, promptKey, sendPromptError, writeInput } from "./_shared";
export default express.Router().post("/", async (req, res) => {
  try { return res.send(success(await saveManagedPrompt(u.db, await promptKey(req), { ...writeInput(req), content: req.body?.content ?? req.body?.data }, promptPaths()))); }
  catch (err) { return sendPromptError(res, err); }
});
