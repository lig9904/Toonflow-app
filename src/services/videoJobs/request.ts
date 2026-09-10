import type { Knex } from "knex";
import { resolveVideoReferenceMediaType } from "@/lib/videoPromptReferences";
import { issueVideoReferenceLease, type VideoReferenceLeaseOptions, type VideoReferenceSource } from "@/services/videoReferenceBridge";
import { VideoJobError } from "./index";

export interface VideoReferenceInput {
  id: number;
  sources: "assets" | "storyboard";
  fileType?: "image" | "video" | "audio";
}

export interface VideoReferenceLoadOptions extends Partial<VideoReferenceLeaseOptions> {
  transport?: "base64" | "url";
}

export type LoadedVideoReference = {
  type: "image" | "video" | "audio";
  base64?: string;
  url?: string;
  source?: VideoReferenceSource;
  leaseId?: string;
  contentHash?: string;
  sizeBytes?: number;
  mtimeMs?: number;
};

export function videoReferenceOptionsForProvider(provider: { referenceTransport?: "base64" | "url" }, rootDir: string): VideoReferenceLoadOptions | undefined {
  if (provider.referenceTransport !== "url") return undefined;
  return {
    transport: "url",
    rootDir,
    publicOrigin: String(process.env.TOONFLOW_MEDIA_PUBLIC_ORIGIN || ""),
    secret: String(process.env.TOONFLOW_MEDIA_BRIDGE_SECRET || ""),
  };
}

export function loadOwnedVideoReferences(
  db: Knex,
  projectId: number,
  scriptId: number,
  uploadData: VideoReferenceInput[],
  toBase64: (path: string) => Promise<string>,
): Promise<Array<{ type: "image" | "video" | "audio"; base64: string }>>;
export function loadOwnedVideoReferences(
  db: Knex,
  projectId: number,
  scriptId: number,
  uploadData: VideoReferenceInput[],
  toBase64: (path: string) => Promise<string>,
  options?: VideoReferenceLoadOptions,
): Promise<LoadedVideoReference[]>;
export async function loadOwnedVideoReferences(
  db: Knex,
  projectId: number,
  scriptId: number,
  uploadData: VideoReferenceInput[],
  toBase64: (path: string) => Promise<string>,
  options: VideoReferenceLoadOptions = {},
): Promise<LoadedVideoReference[]> {
  return Promise.all(uploadData.map(async (item) => {
    if (!Number.isSafeInteger(item.id) || item.id <= 0) throw new VideoJobError("INVALID_INPUT", "引用素材 ID 不合法");
    const source: VideoReferenceSource = { projectId, scriptId, id: item.id, sources: item.sources, fileType: item.fileType };
    if (options.transport === "url") {
      if (!options.rootDir || !options.publicOrigin || !options.secret) throw new VideoJobError("UNSUPPORTED_PROVIDER", "KZ 参考素材桥接未配置媒体公网 origin 或 bridge secret");
      const lease = await issueVideoReferenceLease(db, source, options as VideoReferenceLeaseOptions);
      return { type: lease.type, url: lease.url, source, leaseId: lease.leaseId, contentHash: lease.contentHash, sizeBytes: lease.sizeBytes, mtimeMs: lease.mtimeMs };
    }
    if (item.sources === "storyboard") {
      const row = await db("o_storyboard as storyboard")
        .join("o_script as script", "script.id", "storyboard.scriptId")
        .where("storyboard.id", item.id).where("script.id", scriptId).where("script.projectId", projectId)
        .select("storyboard.filePath").first();
      if (!row?.filePath) throw new VideoJobError("PROJECT_MISMATCH", "分镜引用不属于当前项目或没有媒体文件");
      return { type: "image" as const, base64: await toBase64(row.filePath) };
    }
    const row = await db("o_assets")
      .join("o_scriptAssets as scriptAsset", "scriptAsset.assetId", "o_assets.id")
      .join("o_script as script", "script.id", "scriptAsset.scriptId")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .where("o_assets.id", item.id).where("o_assets.projectId", projectId)
      .where("script.id", scriptId).where("script.projectId", projectId)
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
