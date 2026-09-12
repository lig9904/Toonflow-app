import type { Knex } from "knex";
import type { ImageGenerationReceipt, ImageGenerationService } from "./imageJobs/runtime";
import { snapshotImageReference } from "./imageJobs/referenceSnapshot";

export type RootAssetType = "role" | "scene" | "tool";

export interface RootAssetImageInput {
  projectId: number;
  assetId: number;
  type: RootAssetType;
  name: string;
  prompt: string;
  model: string;
  resolution: string;
  base64?: string | null;
  generationKey: string;
  expectedVersion: number;
}

const labels: Record<RootAssetType,string> = {role:"角色",scene:"场景",tool:"道具"};
export function rootAssetImagePrompt(type:RootAssetType,prompt:string):string{
  if(!prompt.trim())throw Object.assign(new Error("素材提示词不能为空"),{status:400});
  return `生成一张${labels[type]}参考图，画面要求如下：\n${prompt}\n\n主体数量、视角和布局以以上画面要求为准，不额外添加标题、标签、文字或排版。`;
}

export async function prepareRootAssetImage(db: Knex, jobs: ImageGenerationService, input: RootAssetImageInput): Promise<ImageGenerationReceipt> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw Object.assign(new Error("素材版本无效，请重新载入"), { status: 400 });
  const project = await db("o_project").where({ id: input.projectId }).select("id", "artStyle").first();
  if (!project) throw Object.assign(new Error("项目为空"), { status: 404 });
  const asset = await db("o_assets as asset").leftJoin("o_image as selected_image", "selected_image.id", "asset.imageId")
    .where({ "asset.id": input.assetId, "asset.projectId": input.projectId })
    .select("asset.*", "selected_image.filePath as selectedImagePath", "selected_image.state as selectedImageState").first();
  if (!asset) throw Object.assign(new Error("资产不属于当前项目"), { status: 404 });
  if (String(asset.type) !== input.type) throw Object.assign(new Error("资产类型与请求不一致"), { status: 409 });
  if (input.base64 && asset.imageId != null && (!asset.selectedImagePath || asset.selectedImageState === "生成中")) {
    throw Object.assign(new Error("当前素材参考图片不可用，请重新载入"), { status: 409 });
  }
  const selfReference = input.base64 && asset.selectedImagePath ? snapshotImageReference(asset, String(asset.selectedImagePath)) : undefined;
  const prompt = rootAssetImagePrompt(input.type,input.prompt);
  return jobs.prepare({
    generationKey: input.generationKey,
    projectId: input.projectId,
    modelKey: input.model,
    sourceVersion: input.expectedVersion,
    referenceAssets: selfReference ? [selfReference] : undefined,
    referencePaths: input.base64 ? [selfReference?.filePath] : undefined,
    config: {
      prompt,
      referenceList: input.base64 ? [{ type: "image", base64: input.base64 }] : [],
      size: input.resolution,
      aspectRatio: "16:9",
    },
    target: { kind: "asset", id: input.assetId },
  });
}

export async function generateRootAssetImage(db: Knex, jobs: ImageGenerationService, input: RootAssetImageInput, maxWaitMs?: number): Promise<ImageGenerationReceipt> {
  const prepared = await prepareRootAssetImage(db, jobs, input);
  return jobs.submitAndWait({ projectId: input.projectId, jobId: prepared.jobId, maxWaitMs });
}
