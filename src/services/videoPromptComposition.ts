import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Knex } from "knex";
import { isSeedance2Model, resolveVideoReferenceMediaType } from "../lib/videoPromptReferences";
import { videoPromptSystem } from "../lib/videoPromptContract";
import { matchVideoGenerationDuration } from "../lib/videoGenerationTiming";
import { promptDefinitions, readManagedPrompt } from "./promptRegistry";
import { readBoundAudioReferences, type BoundAudioReference } from "./roleAudioWorkspace";
import { resolveVideoMode, type VideoModeCapabilities, type VideoModeResolution, type VideoModeReference, type VideoReferencePurpose } from "./videoModeResolution";

export interface VideoGenerationSettings { duration?: number; resolution?: string; audio?: boolean }
export interface VideoPromptCapabilities { mode?: unknown[]; audio?: boolean | "optional"; durationResolutionMap?: Array<{ duration: number[]; resolution: string[] }> }
export interface VideoPromptComposition {
  system: string; reviewSystem: string; visualManual: string;
  versions: Array<{ key: string; version: string }>;
  context: { model: string; mode: unknown; actualMode: "text" | "firstFrame" | "firstLastFrame" | "multiReference"; scriptDuration: number; generation: VideoGenerationSettings; parameterSource: string; capabilities: VideoPromptCapabilities };
}
export interface VideoReferenceInventory {
  storyboards: any[];
  linkedAssets: any[];
  boundAudio: BoundAudioReference[];
}
export interface VideoPromptReferenceInput { id: number; sources: "storyboard" | "assets"; fileType: "image" | "video" | "audio"; purpose?: VideoReferencePurpose }

/** One authoritative inventory for Workbench and builtin Agent, including current role-audio bindings. */
export async function loadVideoReferenceInventory(db: Knex, input: { projectId: number; scriptId: number; trackIds?: readonly number[] }): Promise<VideoReferenceInventory> {
  let storyboardQuery = db("o_storyboard").where({ projectId: input.projectId, scriptId: input.scriptId });
  if (input.trackIds?.length) storyboardQuery = storyboardQuery.whereIn("trackId", [...new Set(input.trackIds.map(Number))]);
  const storyboards = await storyboardQuery.orderBy("index").orderBy("id").select("id", "trackId", "prompt", "videoDesc", "duration", "filePath");
  const linkedAssets = storyboards.length ? await db("o_assets2Storyboard as link").join("o_assets as asset", "asset.id", "link.assetId").leftJoin("o_image as image", "image.id", "asset.imageId")
    .where("asset.projectId", input.projectId).whereIn("link.storyboardId", storyboards.map((row) => Number(row.id)))
    .select("link.storyboardId", "asset.id", "asset.assetsId", "asset.name", "asset.describe", "asset.type", "asset.imageId", "image.filePath", "image.type as storedFileType").orderBy("link.id") : [];
  const possibleRoleIds = [...new Set(linkedAssets.filter((row) => row.type === "role").flatMap((row) => [Number(row.id), Number(row.assetsId)]).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const ownedRoles = possibleRoleIds.length ? await db("o_assets").where({ projectId: input.projectId, type: "role" }).whereIn("id", possibleRoleIds).select("id") : [];
  const boundAudio = ownedRoles.length ? await readBoundAudioReferences(db, input.projectId, ownedRoles.map((row) => Number(row.id))) : [];
  return { storyboards, linkedAssets, boundAudio };
}

export function buildVideoPromptReferenceCandidates(inventory: VideoReferenceInventory, trackId: number): VideoModeReference[] {
  const boards = inventory.storyboards.filter((row) => Number(row.trackId) === Number(trackId) && row.filePath);
  const boardIds = new Set(inventory.storyboards.filter((row) => Number(row.trackId) === Number(trackId)).map((row) => Number(row.id)));
  const linked = inventory.linkedAssets.filter((row) => boardIds.has(Number(row.storyboardId)));
  const visualAssets = [...new Map(linked.filter((row) => row.filePath).map((row) => [Number(row.id), row])).values()].map((row) => { const fileType = resolveVideoReferenceMediaType(row.storedFileType, row.type, row.filePath); return { id: Number(row.id), sources: "assets" as const, fileType, purpose: fileType === "video" ? "motion_reference" as const : fileType === "audio" ? "audio_reference" as const : row.type === "role" ? "identity_reference" as const : "style_reference" as const }; });
  const roleIds = new Set(linked.filter((row) => row.type === "role").flatMap((row) => [Number(row.id), Number(row.assetsId)]));
  const audioAssets = [...new Map(inventory.boundAudio.filter((row) => roleIds.has(row.roleAssetId)).map((row) => [row.id, row])).values()].map((row) => ({ id: row.id, sources: "assets" as const, fileType: "audio" as const, purpose: "audio_reference" as const }));
  const boardRefs = boards.map((row) => ({ id: Number(row.id), sources: "storyboard" as const, fileType: "image" as const,
    purpose: boards.length === 1 ? "first_frame" as const : "style_reference" as const }));
  return [...boardRefs, ...visualAssets, ...audioAssets];
}

export function resolveInventoryVideoMode(modeIntent: unknown, capabilities: VideoModeCapabilities, inventory: VideoReferenceInventory, trackId: number): VideoModeResolution {
  const all = buildVideoPromptReferenceCandidates(inventory, trackId);
  const parsed = parsePromptMode(modeIntent);
  let references = all;
  if (parsed !== "auto" && !Array.isArray(parsed)) {
    if (parsed === "text") references = [];
    else if (parsed === "singleImage") references = all.filter((item) => item.purpose === "first_frame").slice(0, 1);
    else if (parsed === "startEndRequired") references = all.filter((item) => item.purpose === "first_frame" || item.purpose === "last_frame");
    else if (parsed === "endFrameOptional") references = all.filter((item) => item.purpose === "first_frame" || item.purpose === "last_frame");
    else if (parsed === "startFrameOptional") references = all.filter((item) => item.purpose === "first_frame" || item.purpose === "last_frame");
  }
  return resolveVideoMode({ trackId, modeIntent: parsed, capabilities, references });
}

/** Legacy wrapper. New callers should retain the returned resolvedMode beside these exact references. */
export function selectVideoPromptReferences(mode: unknown, inventory: VideoReferenceInventory, trackId: number, capabilities: VideoModeCapabilities = { mode: [parsePromptMode(mode)] }): VideoPromptReferenceInput[] {
  return resolveInventoryVideoMode(mode, capabilities, inventory, trackId).resolvedReferences;
}
export function parsePromptMode(mode: unknown): unknown { if (typeof mode !== "string") return mode; try { return JSON.parse(mode); } catch { return mode; } }
export function actualVideoPromptMode(mode: unknown, referenceCount: number): VideoPromptComposition["context"]["actualMode"] {
  const parsed = parsePromptMode(mode);
  if (parsed === "text") return "text";
  if (Array.isArray(parsed)) return "multiReference";
  if (parsed === "singleImage" || (["endFrameOptional", "startFrameOptional"].includes(String(parsed)) && referenceCount === 1)) return "firstFrame";
  if (["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(parsed))) return "firstLastFrame";
  throw new Error("无法识别当前视频模式");
}
export function effectiveVideoGeneration(capabilities: VideoPromptCapabilities, scriptDuration: number, input?: VideoGenerationSettings): { generation: VideoGenerationSettings; parameterSource: string } {
  const resolutions = [...new Set((capabilities.durationResolutionMap ?? []).flatMap((entry) => entry.resolution))];
  const resolution = input?.resolution ?? (resolutions.includes("480p") ? "480p" : resolutions[0]);
  if (!resolution) throw new Error("当前模型缺少分辨率与时长能力配置");
  const duration = input?.duration ?? matchVideoGenerationDuration(capabilities, scriptDuration, resolution);
  if (!(capabilities.durationResolutionMap ?? []).some((entry) => entry.resolution.includes(resolution) && entry.duration.includes(duration))) throw new Error("视频时长与分辨率组合不受当前模型支持");
  const audio = input?.audio ?? capabilities.audio === true;
  if ((capabilities.audio === false && audio) || (capabilities.audio === true && !audio)) throw new Error("音频开关与当前模型能力不一致");
  return { generation: { duration, resolution, audio }, parameterSource: input?.duration !== undefined && input.resolution !== undefined && input.audio !== undefined ? "用户本次选择" : "未提供字段按当前模型元数据和脚本时长推导；已提供字段保持原值" };
}
export async function composeVideoPrompt(db: Knex, input: { model: string; mode: unknown; referenceCount: number; scriptDuration: number; generation?: VideoGenerationSettings; capabilities: VideoPromptCapabilities; visualManual?: string }, paths: { skillsDir: string; modelPromptDir: string }): Promise<VideoPromptComposition> {
  const actualMode = actualVideoPromptMode(input.mode, input.referenceCount);
  const parsedMode = parsePromptMode(input.mode);
  if (!(input.capabilities.mode ?? []).some((mode) => JSON.stringify(mode) === JSON.stringify(parsedMode))) throw new Error("当前模式不受所选模型支持");
  const [vendorId, modelName] = input.model.split(/:(.+)/);
  const bound = await db("o_modelPrompt").where({ vendorId, model: modelName }).first();
  const supplement = isSeedance2Model(modelName) ? "video.seedance" : /wan.*2[.-]6/iu.test(modelName ?? "") ? "video.wan26" : null;
  const modeKey = `video.${actualMode}`;
  const parts = await Promise.all(["common.videoPromptGeneration", modeKey, ...(!bound?.path && supplement ? [supplement] : []), "review.videoPromptReview"].map(async (key) => ({ ...(await readManagedPrompt(db, key, paths)), key })));
  const review = parts.pop()!;
  if (bound?.path) {
    const normalizedPath = String(bound.path).replace(/\\/g, "/").replace(/^\.\//, "");
    const registered = promptDefinitions.find((definition) => definition.file === normalizedPath);
    if (registered) {
      if (registered.group !== "video") throw new Error("显式视频模型映射只能选择视频提示词");
      if (registered.key.startsWith("video.") && ![modeKey, "video.seedance", "video.wan26"].includes(registered.key)) throw new Error(`显式模型提示词映射 ${registered.key} 与当前模式 ${modeKey} 不匹配`);
      if (!parts.some((part) => part.key === registered.key)) parts.push({ ...(await readManagedPrompt(db, registered.key, paths)), key: registered.key });
    } else {
      const root = await fs.realpath(paths.modelPromptDir);
      const absolute = await fs.realpath(path.resolve(root, normalizedPath));
      const relative = path.relative(root, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("模型提示词映射超出模板目录");
      const content = await fs.readFile(absolute, "utf8");
      if (!content.trim()) throw new Error("显式模型提示词映射为空");
      parts.push({ key: `modelMapping:${vendorId}:${modelName}`, content, version: createHash("sha256").update(content).digest("hex") } as typeof parts[number]);
    }
  }
  return { system: videoPromptSystem(parts.map((part) => `【${part.key}】\n${part.content}`).join("\n\n")), reviewSystem: review.content, visualManual: input.visualManual ?? "",
    versions: [...parts, review].map(({ key, version }) => ({ key, version })),
    context: { model: input.model, mode: parsedMode, actualMode, scriptDuration: input.scriptDuration, ...effectiveVideoGeneration(input.capabilities, input.scriptDuration, input.generation), capabilities: input.capabilities } };
}

/** Counts come from the selected media and the configured mode, never prose defaults. */
export function validatePromptReferenceSelection(mode: unknown, types: Array<"image" | "video" | "audio">): void {
  const parsed = parsePromptMode(mode);
  if (parsed === "text") { if (types.length) throw new Error("文生模式不能选择参考媒体"); return; }
  if (Array.isArray(parsed)) {
    for (const type of ["image", "video", "audio"] as const) {
      const entry = parsed.find((item) => typeof item === "string" && item.startsWith(`${type}Reference:`));
      const limit = entry ? Number(String(entry).split(":")[1]) : 0;
      if (!Number.isInteger(limit) || limit < 0) throw new Error("当前模型参考数量能力配置无效");
      if (types.filter((media) => media === type).length > limit) throw new Error(`当前 ${type} 参考数量超过所选模式配置`);
    }
    return;
  }
  if (types.some((type) => type !== "image")) throw new Error("当前首帧或首尾帧模式仅接受图片参考");
  if (parsed === "singleImage" && types.length === 1) return;
  if (parsed === "startEndRequired" && types.length === 2) return;
  if (["endFrameOptional", "startFrameOptional"].includes(String(parsed)) && types.length >= 1 && types.length <= 2) return;
  throw new Error("参考数量不符合当前首帧或首尾帧模式");
}
