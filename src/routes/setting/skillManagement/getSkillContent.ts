import express from "express";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import fs from "node:fs/promises";
import u from "@/utils";
import { readManagedPrompt } from "@/services/promptRegistry";
import { promptPaths, sendPromptError } from "../promptManage/_shared";
import { resolveSkillTarget } from "./_managedSkill";
export default express.Router().post("/", validateFields({ path: z.string().min(1) }), async (req, res) => {
  try {
    const target = await resolveSkillTarget(req.body.path, u.getPath("skills"));
    if (target.managedKey) {
      const entry = await readManagedPrompt(u.db, target.managedKey, promptPaths());
      return res.send(success({ ...entry, managedKey: target.managedKey }));
    }
    return res.send(success(await fs.readFile(target.target, "utf8")));
  } catch (err) { return sendPromptError(res, err); }
});
