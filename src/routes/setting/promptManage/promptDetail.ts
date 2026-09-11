import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { readManagedPrompt } from "@/services/promptRegistry";
import { promptPaths, promptKey, sendPromptError, writeInput } from "./_shared";
export default express.Router().post("/", async (req, res) => {
  try { return res.send(success(await readManagedPrompt(u.db, await promptKey(req), promptPaths()))); }
  catch (err) { return sendPromptError(res, err); }
});
