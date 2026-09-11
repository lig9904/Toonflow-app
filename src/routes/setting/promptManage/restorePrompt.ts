import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { restoreManagedPrompt } from "@/services/promptRegistry";
import { promptPaths, promptKey, sendPromptError, writeInput } from "./_shared";
export default express.Router().post("/", async (req, res) => {
  try { return res.send(success(await restoreManagedPrompt(u.db, await promptKey(req), { ...writeInput(req), historyVersion: req.body?.historyVersion }, promptPaths()))); }
  catch (err) { return sendPromptError(res, err); }
});
