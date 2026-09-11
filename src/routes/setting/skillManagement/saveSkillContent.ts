import express from "express";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import fs from "node:fs/promises";
import u from "@/utils";
import { saveManagedPrompt } from "@/services/promptRegistry";
import { promptPaths, sendPromptError, writeInput } from "../promptManage/_shared";
import { resolveSkillTarget } from "./_managedSkill";
export default express.Router().post("/", validateFields({ path: z.string().min(1), content: z.string() }), async (req, res) => {
  try {
    const target = await resolveSkillTarget(req.body.path, u.getPath("skills"));
    if (target.managedKey) {
      const entry = await saveManagedPrompt(u.db, target.managedKey, { ...writeInput(req), content: req.body.content }, promptPaths());
      return res.send(success({ ...entry, managedKey: target.managedKey }));
    }
    await fs.writeFile(target.target, req.body.content, "utf8");
    return res.send(success(null));
  } catch (err) { return sendPromptError(res, err); }
});
