import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { listPromptHistory } from "@/services/promptRegistry";
import { promptPaths, promptKey, sendPromptError, writeInput } from "./_shared";
export default express.Router().post("/", async (req, res) => {
  try { return res.send(success(await listPromptHistory(u.db, await promptKey(req), promptPaths()))); }
  catch (err) { return sendPromptError(res, err); }
});
