import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveSkillTarget } from "../src/routes/setting/skillManagement/_managedSkill";

test("builtin paths and symlink aliases resolve to the same managed key; ordinary skills stay file-backed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-skill-"));
  try {
    await fs.writeFile(path.join(root, "builtin_production_review.md"), "builtin");
    await fs.writeFile(path.join(root, "custom.md"), "custom");
    await fs.mkdir(path.join(root, "nested"));
    await fs.symlink(path.join(root, "builtin_production_review.md"), path.join(root, "alias.md"));
    for (const input of ["builtin_production_review.md", "./builtin_production_review.md", "nested/../builtin_production_review.md", "alias.md"]) {
      assert.equal((await resolveSkillTarget(input, root)).managedKey, "skill.builtin_production_review");
    }
    assert.equal((await resolveSkillTarget("custom.md", root)).managedKey, undefined);
    await fs.symlink(path.resolve("package.json"), path.join(root, "escape.md"));
    await assert.rejects(resolveSkillTarget("escape.md", root), /无效/);
    await assert.rejects(resolveSkillTarget(path.resolve("package.json"), root), /无效/);
    await assert.rejects(resolveSkillTarget(".", root), /无效/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
