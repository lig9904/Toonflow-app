import type { Knex } from "knex";
import { assertImageArtifactProject, ensureProductionImageJobSchema, type ImageGenerationService } from "./imageJobs/runtime";

export interface GenerateFlowImageInput {
  projectId: number;
  scriptId?: number;
  flowId?: number;
  nodeId?: string;
  model: string;
  quality: string;
  ratio: string;
  prompt: string;
  references: string[];
  generationKey: string;
}

export async function generateFlowImage(db: Knex, jobs: ImageGenerationService, input: GenerateFlowImageInput, loaders: {
  local(path: string): Promise<string>;
  remote(url: string): Promise<string>;
}) {
  if (!(await db("o_project").where({ id: input.projectId }).first())) throw Object.assign(new Error("项目不存在"), { status: 404 });
  if (input.scriptId != null && !(await db("o_script").where({ id: input.scriptId, projectId: input.projectId }).first())) {
    throw Object.assign(new Error("剧集不属于当前项目"), { status: 404 });
  }
  await ensureProductionImageJobSchema(db);
  const referenceList: Array<{ type: "image"; base64: string }> = [];
  for (const reference of input.references) {
    if (isLocalMediaReference(reference)) {
      const path = await assertImageArtifactProject(db, input.projectId, reference);
      referenceList.push({ type: "image", base64: await loaders.local(path) });
    } else {
      referenceList.push({ type: "image", base64: await loaders.remote(reference) });
    }
  }
  const targetId = input.flowId != null ? input.flowId : input.nodeId ? input.nodeId : input.generationKey;
  return jobs.prepareAndSubmit({
    generationKey: input.generationKey,
    projectId: input.projectId,
    modelKey: input.model,
    config: { prompt: input.prompt, referenceList, size: input.quality, aspectRatio: input.ratio },
    target: { kind: "flow", id: targetId, scriptId: input.scriptId },
  });
}

function isLocalMediaReference(value: string): boolean {
  if (value.startsWith("/oss/") || value.startsWith("oss/")) return true;
  if (!/^https?:\/\//i.test(value)) return true;
  try { return new URL(value).pathname.startsWith("/oss/"); } catch { return false; }
}
