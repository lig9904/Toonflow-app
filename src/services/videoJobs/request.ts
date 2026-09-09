import type { Knex } from "knex";
import { resolveVideoReferenceMediaType } from "@/lib/videoPromptReferences";
import { VideoJobError } from "./index";

export interface VideoReferenceInput {
  id: number;
  sources: "assets" | "storyboard";
  fileType?: "image" | "video" | "audio";
}

export async function loadOwnedVideoReferences(
  db: Knex,
  projectId: number,
  scriptId: number,
  uploadData: VideoReferenceInput[],
  toBase64: (path: string) => Promise<string>,
): Promise<Array<{ type: "image" | "video" | "audio"; base64: string }>> {
  return Promise.all(uploadData.map(async (item) => {
    if (!Number.isSafeInteger(item.id) || item.id <= 0) throw new VideoJobError("INVALID_INPUT", "引用素材 ID 不合法");
    if (item.sources === "storyboard") {
      const row = await db("o_storyboard as storyboard")
        .join("o_script as script", "script.id", "storyboard.scriptId")
        .where("storyboard.id", item.id).where("script.id", scriptId).where("script.projectId", projectId)
        .select("storyboard.filePath").first();
      if (!row?.filePath) throw new VideoJobError("PROJECT_MISMATCH", "分镜引用不属于当前项目或没有媒体文件");
      return { type: "image" as const, base64: await toBase64(row.filePath) };
    }
    const row = await db("o_assets")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .where("o_assets.id", item.id).where("o_assets.projectId", projectId)
      .select("o_image.filePath", "o_image.type").first();
    if (!row?.filePath) throw new VideoJobError("PROJECT_MISMATCH", "资产引用不属于当前项目或没有媒体文件");
    return {
      type: resolveVideoReferenceMediaType(item.fileType, row.type, row.filePath),
      base64: await toBase64(row.filePath),
    };
  }));
}

export function parseVideoMode(mode: unknown): unknown {
  if (Array.isArray(mode)) return mode;
  if (typeof mode === "string" && mode.startsWith("[")) {
    try { return JSON.parse(mode); } catch { throw new VideoJobError("INVALID_INPUT", "视频模式不是有效 JSON"); }
  }
  return mode;
}
