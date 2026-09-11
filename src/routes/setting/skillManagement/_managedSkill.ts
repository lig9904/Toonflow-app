import fs from "node:fs/promises";
import path from "node:path";
import { promptDefinitions, PromptRegistryError } from "@/services/promptRegistry";
/** Resolve existing paths before registry lookup so aliases cannot bypass builtin CAS. */
export async function resolveSkillTarget(relativePath: string, skillsRoot: string) {
  const root = await fs.realpath(skillsRoot);
  const target = await fs.realpath(path.resolve(root, relativePath));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".md")) throw new PromptRegistryError("INVALID_INPUT", "无效的 Skill 路径");
  const definition = promptDefinitions.find(p => p.group === "skill" && p.file === relative.split(path.sep).join("/"));
  return { target, managedKey: definition?.key };
}
