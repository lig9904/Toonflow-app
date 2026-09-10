import type { Knex } from "knex";
import fs from "node:fs";

export const PROJECT_IMAGE_QUALITIES = ["1K", "2K", "4K"] as const;
export const PROJECT_VIDEO_RATIOS = ["16:9", "9:16"] as const;

export interface ProjectModelMetadata {
  key: string;
  type: "image" | "video" | "text";
  modes: readonly unknown[];
  resolutions?: readonly string[];
}

export interface ProjectConfigurationMetadata {
  models: readonly ProjectModelMetadata[];
  artStyles: readonly string[];
  directorManuals: readonly string[];
  imageQualities?: readonly string[];
  videoRatios?: readonly string[];
}

export interface ProjectConfigurationFields {
  imageModel: string;
  videoModel: string;
  imageQuality: string;
  videoRatio: string;
  mode: string;
  artStyle: string;
  directorManual: string;
}

export type VendorModelLoader = (vendorId: string) => Promise<readonly unknown[]>;

export function listConfigurationDirectories(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function modeKey(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return JSON.stringify(value);
  return null;
}

/**
 * Loads only non-secret model metadata from enabled vendors. Provider input
 * values and API keys are deliberately never queried or returned.
 */
export async function loadEnabledProjectModels(db: Knex, loadModels: VendorModelLoader): Promise<ProjectModelMetadata[]> {
  const vendors = await db("o_vendorConfig").where({ enable: 1 }).select("id").orderBy("id");
  const result: ProjectModelMetadata[] = [];
  for (const row of vendors) {
    const vendorId = String(row.id ?? "").trim();
    if (!vendorId) continue;
    const models = await loadModels(vendorId);
    for (const raw of models) {
      if (!raw || typeof raw !== "object") continue;
      const model = raw as Record<string, unknown>;
      const modelName = typeof model.modelName === "string" ? model.modelName.trim() : "";
      const type = model.type;
      if (!modelName || (type !== "image" && type !== "video" && type !== "text")) continue;
      result.push({ key: `${vendorId}:${modelName}`, type, modes: Array.isArray(model.mode) ? model.mode : [], ...(Array.isArray(model.resolutions) ? { resolutions: model.resolutions.filter((value): value is string => typeof value === "string") } : {}) });
    }
  }
  return result;
}

/** Returns a user-safe validation message, or null when the Web selection is valid. */
export function projectConfigurationIssue(input: ProjectConfigurationFields, metadata: ProjectConfigurationMetadata): string | null {
  const image = metadata.models.find((model) => model.key === input.imageModel);
  if (!image) return "图片模型所属供应商未启用或模型不存在";
  if (image.type !== "image") return "所选图片模型类型不正确";

  const video = metadata.models.find((model) => model.key === input.videoModel);
  if (!video) return "视频模型所属供应商未启用或模型不存在";
  if (video.type !== "video") return "所选视频模型类型不正确";
  const supportedModes = new Set(video.modes.map(modeKey).filter((value): value is string => value !== null));
  if (!supportedModes.has(input.mode)) return "所选视频模型不支持该生成模式";

  const qualities = image.resolutions ?? metadata.imageQualities ?? PROJECT_IMAGE_QUALITIES;
  if (!qualities.includes(input.imageQuality)) return `所选图片质量 ${input.imageQuality} 不受当前模型支持，可选：${qualities.join("、")}`;
  const ratios = metadata.videoRatios ?? PROJECT_VIDEO_RATIOS;
  if (!ratios.includes(input.videoRatio)) return "画面比例不在 Web 可选范围内";
  if (!metadata.artStyles.includes(input.artStyle)) return "所选视觉手册不存在";
  if (!metadata.directorManuals.includes(input.directorManual)) return "所选导演手册不存在";
  return null;
}
