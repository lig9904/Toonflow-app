import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { listManagedPrompts } from "@/services/promptRegistry";
import { promptPaths, promptKey, sendPromptError, writeInput } from "./_shared";
export default express.Router().post("/", async (req, res) => {
  try { return res.send(success(await listManagedPrompts(u.db, promptPaths()))); }
  catch (err) { return sendPromptError(res, err); }
});
