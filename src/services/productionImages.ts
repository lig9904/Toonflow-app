import { insertRowsReturningIds } from "../lib/insertRows";
import { isPostgres, withProjectTransaction } from "../lib/dbTransaction";
import type { Knex } from "knex";
import { notifyProductionChange } from "./productionEvents";
import { assertAssetNotLockedReference, ProductionAssetError } from "./productionAssets";
import { ImageGenerationError, type ImageGenerationReceipt, type ImageGenerationService } from "./imageJobs/runtime";

export class ProductionImageError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "ProductionImageError";
  }
}

export type ProductionReference = { type: "image"; base64: string };
export interface GeneratedImage { save(path: string): Promise<unknown> }
export interface ProductionImageRuntime {
  getArtPrompt(style: string, source: string, fileName: string): string;
  generatePrompt(input: { system: string; parentDescription: string; description: string }): Promise<string>;
  generateImage?(input: {
    model: string; prompt: string; size: "1K" | "2K" | "4K"; aspectRatio: `${number}:${number}`;
    referenceList: ProductionReference[]; projectId: number; scriptId: number; kind: "asset" | "storyboard";
  }): Promise<GeneratedImage>;
  imageJobs?: ImageGenerationService;
  getImageBase64(path: string): Promise<string>;
  getSmallImageUrl(path: string): Promise<string>;
  uuid(): string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length || 1));
  let cursor = 0;
  return Promise.all(Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]);
    }
  })).then(() => undefined);
}

async function projectSettings(db: Knex, projectId: number) {
  const settings = await db("o_project").where({ id: projectId }).select("imageModel", "imageQuality", "artStyle", "videoRatio").first();
  if (!settings) throw new ProductionImageError("项目不存在", 404);
  if (!settings.imageModel || !settings.imageQuality) throw new ProductionImageError("项目图片模型配置不完整", 400);
  return settings;
}

async function assertEpisode(db: Knex | Knex.Transaction, projectId: number, scriptId: number) {
  const script = await db("o_script").where({ id: scriptId, projectId }).first();
  if (!script) throw new ProductionImageError("剧集不属于当前项目", 404);
  return script;
}

async function assertAssetWritable(db: Knex.Transaction, assetId: number): Promise<void> {
  try { await assertAssetNotLockedReference(db, assetId); }
  catch (error) { if (error instanceof ProductionAssetError) throw new ProductionImageError(error.message, error.status); throw error; }
}

const promptFileByType: Record<string, string> = {
  role: "art_character_derivative",
  tool: "art_prop_derivative",
  scene: "art_scene_derivative",
};

export async function prepareDerivedAssetImages(db: Knex, args: {
  projectId: number; scriptId: number; assetIds: number[]; concurrentCount?: number; runtime: ProductionImageRuntime; generationKeyPrefix?: string;
}) {
  if (args.runtime.imageJobs) return prepareDurableDerivedAssetImages(db, args as typeof args & { runtime: ProductionImageRuntime & { imageJobs: ImageGenerationService } });
  const ids = [...new Set(args.assetIds)];
  if (!ids.length) throw new ProductionImageError("assetIds不能为空");
  const settings = await projectSettings(db, args.projectId);
  const prepared = await withProjectTransaction(db, args.projectId, async (trx) => {
    await assertEpisode(trx, args.projectId, args.scriptId);
    const assets = await trx("o_assets").whereIn("id", ids);
    if (assets.length !== ids.length || assets.some((asset) => Number(asset.projectId) !== args.projectId)) {
      throw new ProductionImageError("资产不属于当前项目", 404);
    }
    const links = await trx("o_scriptAssets").where({ scriptId: args.scriptId }).whereIn("assetId", ids);
    if (links.length !== ids.length) throw new ProductionImageError("资产不属于当前剧集", 400);
    const parentIds = [...new Set(assets.map((asset) => asset.assetsId).filter((id): id is number => id != null))];
    const parents = parentIds.length ? await trx("o_assets").leftJoin("o_image", "o_assets.imageId", "o_image.id").whereIn("o_assets.id", parentIds).andWhere("o_assets.projectId", args.projectId).select("o_assets.id", "o_assets.imageId", "o_assets.describe", "o_image.filePath", "o_image.state") : [];
    if (parents.length !== parentIds.length) throw new ProductionImageError("父资产不属于当前项目", 400);
    for (const parent of parents) if (parent.imageId != null && !parent.filePath) throw new ProductionImageError("父资产图片原材料不存在", 400);
    for (const parent of parents) if (parent.imageId != null && parent.state === "生成中") throw new ProductionImageError("父资产图片正在生成中，请稍后重试", 409);
    for (const asset of assets) await assertAssetWritable(trx, Number(asset.id));
    return { assets, parents };
  });
  const parentPath = new Map<number, string>();
  for (const parent of prepared.parents) {
    if (parent.filePath) parentPath.set(Number(parent.id), String(parent.filePath));
  }
  const parentBase64 = new Map<number, string>();
  for (const [parentId, filePath] of parentPath) parentBase64.set(parentId, await args.runtime.getImageBase64(filePath));

  const imageIdByAsset = new Map<number, number>();
  await withProjectTransaction(db, args.projectId, async (trx) => {
    for (const asset of prepared.assets) {
      const current = await trx("o_assets").where({ id: asset.id, projectId: args.projectId }).first();
      if (!current || Number(current.imageId ?? 0) !== Number(asset.imageId ?? 0)) throw new ProductionImageError("资产已被其他操作修改，请重新载入", 409);
      await assertAssetWritable(trx, Number(asset.id));
      if (current.imageId != null && (await trx("o_image").where({ id: current.imageId, state: "生成中" }).first())) throw new ProductionImageError("资产正在生成中，请稍后重试", 409);
      const [imageId] = await insertRowsReturningIds(trx, "o_image", { assetsId: asset.id, type: asset.type, state: "生成中", resolution: settings.imageQuality, model: settings.imageModel });
      await trx("o_assets").where({ id: asset.id, projectId: args.projectId }).update({ imageId });
      imageIdByAsset.set(Number(asset.id), Number(imageId));
    }
  });

  const preview = prepared.assets.map((asset) => ({ id: Number(asset.id), name: asset.name ?? "", type: asset.type ?? "", state: "生成中", src: "" }));
  notifyProductionChange({ projectId: args.projectId, scriptId: args.scriptId });
  const run = async () => {
    const results: Array<{ id: number; state: string; src: string; errorReason?: string }> = [];
    await bounded(prepared.assets, args.concurrentCount ?? 5, async (asset) => {
    const imageId = imageIdByAsset.get(Number(asset.id))!;
    try {
      const type = String(asset.type || "role");
      const prompt = await args.runtime.generatePrompt({
        system: args.runtime.getArtPrompt(String(settings.artStyle || "无"), "art_skills", promptFileByType[type] || promptFileByType.role),
        parentDescription: String(asset.assetsId ? prepared.parents.find((parent) => parent.id === asset.assetsId)?.describe || "无详细描述" : "无详细描述"),
        description: String(asset.describe || "无详细描述"),
      });
      const currentAsset = await db("o_assets").where({ id: asset.id, projectId: args.projectId }).first();
      if (!currentAsset || Number(currentAsset.imageId ?? 0) !== imageId || String(currentAsset.describe ?? "") !== String(asset.describe ?? "")) {
        const errorReason = "资产已被其他操作修改，已停止图片生成";
        await db("o_image").where({ id: imageId, assetsId: asset.id }).update({ state: "生成失败", errorReason });
        results.push({ id: Number(asset.id), state: "生成失败", src: "", errorReason });
        return;
      }
      await db("o_assets").where({ id: asset.id, projectId: args.projectId }).update({ prompt });
      const reference = asset.assetsId != null && parentBase64.has(Number(asset.assetsId)) ? [{ type: "image" as const, base64: parentBase64.get(Number(asset.assetsId))! }] : [];
      const image = await args.runtime.generateImage!({ model: String(settings.imageModel), prompt, size: settings.imageQuality as "1K" | "2K" | "4K", aspectRatio: "16:9", referenceList: reference, projectId: args.projectId, scriptId: args.scriptId, kind: "asset" });
      const savePath = `/${args.projectId}/assets/${args.scriptId}/${type}/${args.runtime.uuid()}.jpg`;
      await image.save(savePath);
      await db("o_image").where({ id: imageId, assetsId: asset.id }).update({ state: "已完成", filePath: savePath, errorReason: null });
      results.push({ id: Number(asset.id), state: "已完成", src: await args.runtime.getSmallImageUrl(savePath) });
    } catch (error) {
      const errorReason = messageOf(error);
      await db("o_image").where({ id: imageId, assetsId: asset.id }).update({ state: "生成失败", errorReason });
      results.push({ id: Number(asset.id), state: "生成失败", src: "", errorReason });
    }
    });
    notifyProductionChange({ projectId: args.projectId, scriptId: args.scriptId });
    return results;
  };
  return { preview, run };
}

export async function generateDerivedAssetImages(db: Knex, args: {
  projectId: number; scriptId: number; assetIds: number[]; concurrentCount?: number; runtime: ProductionImageRuntime; generationKeyPrefix?: string;
}) {
  const prepared = await prepareDerivedAssetImages(db, args);
  return prepared.run();
}

export async function prepareStoryboardImages(db: Knex, args: {
  projectId: number; scriptId: number; storyboardIds: number[]; concurrentCount?: number; compulsory?: boolean; runtime: ProductionImageRuntime; generationKeyPrefix?: string;
}) {
  if (args.runtime.imageJobs) return prepareDurableStoryboardImages(db, args as typeof args & { runtime: ProductionImageRuntime & { imageJobs: ImageGenerationService } });
  const ids = [...new Set(args.storyboardIds)];
  if (!ids.length) throw new ProductionImageError("storyboardIds不能为空");
  const settings = await projectSettings(db, args.projectId);
  const prepared = await withProjectTransaction(db, args.projectId, async (trx) => {
    await assertEpisode(trx, args.projectId, args.scriptId);
    const storyboards = await trx("o_storyboard").where({ projectId: args.projectId, scriptId: args.scriptId }).whereIn("id", ids);
    if (storyboards.length !== ids.length) throw new ProductionImageError("分镜不属于当前项目或剧集", 404);
    const locked = await trx("ext_entity_state").where({ entityType: "storyboard", locked: 1 }).whereIn("entityId", ids).first();
    if (locked) throw new ProductionImageError("锁定分镜不能生成图片", 423);
    if (storyboards.some((row) => row.state === "生成中")) throw new ProductionImageError("分镜正在生成中，请稍后重试", 409);
    const links = await trx("o_assets2Storyboard").whereIn("storyboardId", ids).orderBy(isPostgres(trx) ? "id" : "rowid");
    const assetIds = [...new Set(links.map((row) => row.assetId))];
    const assets = assetIds.length ? await trx("o_assets").whereIn("id", assetIds) : [];
    if (assets.length !== assetIds.length || assets.some((asset) => Number(asset.projectId) !== args.projectId)) throw new ProductionImageError("分镜引用素材不属于当前项目", 400);
    const missingImages = assets.filter((asset) => asset.imageId == null);
    if (missingImages.length) throw new ProductionImageError(`请先生成并选用引用素材的图片：${missingImages.map((asset) => asset.name || `ID ${asset.id}`).join("、")}`, 400);
    const imageIds = [...new Set(assets.map((asset) => asset.imageId).filter((id): id is number => id != null))];
    const images = imageIds.length ? await trx("o_image").whereIn("id", imageIds) : [];
    if (images.length !== imageIds.length || images.some((image) => !image.filePath)) throw new ProductionImageError("分镜引用的图片原材料不存在", 400);
    if (images.some((image) => image.state === "生成中")) throw new ProductionImageError("分镜引用图片正在生成中，请稍后重试", 409);
    const states = await trx("ext_entity_state").where({ entityType: "storyboard" }).whereIn("entityId", ids);
    return { storyboards, links, assets, images, stateVersions: new Map(states.map((state) => [Number(state.entityId), Number(state.version)])) };
  });
  const imageBase64 = new Map<number, string>();
  for (const image of prepared.images) imageBase64.set(Number(image.id), await args.runtime.getImageBase64(String(image.filePath)));
  const assetMap = new Map(prepared.assets.map((asset) => [Number(asset.id), asset]));
  const imageIdsByStoryboard = new Map<number, number[]>();
  for (const link of prepared.links) {
    const asset = assetMap.get(Number(link.assetId));
    if (!asset) throw new ProductionImageError("分镜引用素材缺失", 400);
    if (!imageIdsByStoryboard.has(Number(link.storyboardId))) imageIdsByStoryboard.set(Number(link.storyboardId), []);
    if (asset.imageId != null) imageIdsByStoryboard.get(Number(link.storyboardId))!.push(Number(asset.imageId));
  }
  const claimed = new Map<number, { version: number; token: string }>();
  await withProjectTransaction(db, args.projectId, async (trx) => {
    const currentAssets = await trx("o_assets").whereIn("id", prepared.assets.map((asset) => asset.id)).andWhere("projectId", args.projectId);
    if (currentAssets.length !== prepared.assets.length || currentAssets.some((asset) => Number(asset.projectId) !== args.projectId)) throw new ProductionImageError("分镜引用素材已被其他操作修改，请重新载入", 409);
    for (const asset of prepared.assets) {
      const current = currentAssets.find((item) => Number(item.id) === Number(asset.id));
      if (Number(current?.imageId ?? 0) !== Number(asset.imageId ?? 0)) throw new ProductionImageError("分镜引用图片已被其他操作修改，请重新载入", 409);
    }
    const currentImages = prepared.images.length ? await trx("o_image").whereIn("id", prepared.images.map((image) => image.id)) : [];
    for (const image of prepared.images) {
      const current = currentImages.find((item) => Number(item.id) === Number(image.id));
      if (!current || current.filePath !== image.filePath || current.state === "生成中") throw new ProductionImageError("分镜图片原材料已被其他操作修改，请重新载入", 409);
    }
    for (const row of prepared.storyboards) {
      if (args.compulsory || row.shouldGenerateImage !== 0) {
        const expectedVersion = prepared.stateVersions.get(Number(row.id)) ?? 0;
        let state = await trx("ext_entity_state").where({ entityType: "storyboard", entityId: row.id }).first();
        if (!state) {
          await trx("ext_entity_state").insert({ entityType: "storyboard", entityId: row.id, projectId: args.projectId, version: 0, reviewState: "draft", locked: 0 });
          state = await trx("ext_entity_state").where({ entityType: "storyboard", entityId: row.id }).first();
        }
        if (Number(state.version) !== expectedVersion || state.internalMutation) throw new ProductionImageError("分镜已被其他操作修改，请重新载入", 409);
        const token = `storyboard-image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const reserved = await trx("ext_entity_state").where({ entityType: "storyboard", entityId: row.id, version: expectedVersion }).update({ version: expectedVersion + 1, internalMutation: token, updatedAt: Date.now() });
        if (reserved !== 1) throw new ProductionImageError("分镜已被其他操作修改，请重新载入", 409);
        const changed = await trx("o_storyboard").where({ id: row.id, projectId: args.projectId, scriptId: args.scriptId, state: row.state }).update({ state: "生成中", shouldGenerateImage: 1 });
        if (changed !== 1) throw new ProductionImageError("分镜已被其他操作修改，请重新载入", 409);
        claimed.set(Number(row.id), { version: expectedVersion + 1, token });
      }
    }
  });
  const writeStoryboardResult = async (id: number, patch: Record<string, unknown>) => {
    await withProjectTransaction(db, args.projectId, async (trx) => {
      const claim = claimed.get(id);
      const state = await trx("ext_entity_state").where({ entityType: "storyboard", entityId: id }).first();
      if (!claim || Number(state?.version ?? 0) !== claim.version || state?.internalMutation !== claim.token) throw new ProductionImageError("分镜已被其他操作修改，忽略过期生成结果", 409);
      const changed = await trx("o_storyboard").where({ id, projectId: args.projectId, scriptId: args.scriptId, state: "生成中" }).update(patch);
      if (changed !== 1) throw new ProductionImageError("分镜已被其他操作修改，忽略过期生成结果", 409);
      await trx("ext_entity_state").where({ entityType: "storyboard", entityId: id, version: claim.version, internalMutation: claim.token }).update({ version: claim.version + 1, internalMutation: null, updatedAt: Date.now() });
    });
  };
  const releaseStaleClaim = async (id: number, reason: string) => {
    await withProjectTransaction(db, args.projectId, async (trx) => {
      const claim = claimed.get(id);
      const state = await trx("ext_entity_state").where({ entityType: "storyboard", entityId: id }).first();
      const row = await trx("o_storyboard").where({ id, projectId: args.projectId, scriptId: args.scriptId }).first();
      if (!claim || !state || !row || row.state !== "生成中") return;
      const changed = await trx("o_storyboard").where({ id, projectId: args.projectId, scriptId: args.scriptId, state: "生成中" }).update({ state: "生成失败", reason });
      if (changed === 1) await trx("ext_entity_state").where({ entityType: "storyboard", entityId: id, version: state.version, internalMutation: state.internalMutation ?? null }).update({ version: Number(state.version) + 1, internalMutation: null, updatedAt: Date.now() });
    });
  };
  const generateList = args.compulsory ? prepared.storyboards : prepared.storyboards.filter((row) => row.shouldGenerateImage !== 0);
  const preview = prepared.storyboards.map((row) => ({
    id: Number(row.id), prompt: row.prompt ?? "", videoDesc: row.videoDesc ?? "", shouldGenerateImage: row.shouldGenerateImage,
    state: generateList.some((item) => item.id === row.id) ? "生成中" : row.state, src: row.filePath ?? null,
    associateAssetsIds: prepared.links.filter((link) => link.storyboardId === row.id).map((link) => link.assetId),
  }));
  notifyProductionChange({ projectId: args.projectId, scriptId: args.scriptId });
  const run = async () => {
    const results: Array<{ id: number; state: string; src: string; errorReason?: string }> = [];
    await bounded(generateList, args.concurrentCount ?? 5, async (row) => {
    try {
      const references = (imageIdsByStoryboard.get(Number(row.id)) || []).map((id) => ({ type: "image" as const, base64: imageBase64.get(id)! }));
      const image = await args.runtime.generateImage!({ model: String(settings.imageModel), prompt: String(row.prompt || ""), size: settings.imageQuality as "1K" | "2K" | "4K", aspectRatio: (settings.videoRatio || "16:9") as `${number}:${number}`, referenceList: references, projectId: args.projectId, scriptId: args.scriptId, kind: "storyboard" });
      const savePath = `/${args.projectId}/assets/${args.scriptId}/${args.runtime.uuid()}.jpg`;
      await image.save(savePath);
      await writeStoryboardResult(Number(row.id), { filePath: savePath, state: "已完成", reason: null });
      results.push({ id: Number(row.id), state: "已完成", src: await args.runtime.getSmallImageUrl(savePath) });
    } catch (error) {
      const errorReason = messageOf(error);
      try { await writeStoryboardResult(Number(row.id), { reason: errorReason, state: "生成失败" }); } catch { try { await releaseStaleClaim(Number(row.id), errorReason); } catch { /* stale generation must not overwrite newer content or clear its image */ } }
      results.push({ id: Number(row.id), state: "生成失败", src: "", errorReason });
    }
    });
    notifyProductionChange({ projectId: args.projectId, scriptId: args.scriptId });
    return results;
  };
  return { preview, run };
}

export async function generateStoryboardImages(db: Knex, args: {
  projectId: number; scriptId: number; storyboardIds: number[]; concurrentCount?: number; compulsory?: boolean; runtime: ProductionImageRuntime; generationKeyPrefix?: string;
}) {
  const prepared = await prepareStoryboardImages(db, args);
  return prepared.run();
}

type DurableRuntime = ProductionImageRuntime & { imageJobs: ImageGenerationService };

async function prepareDurableDerivedAssetImages(db: Knex, args: {
  projectId: number; scriptId: number; assetIds: number[]; concurrentCount?: number; runtime: DurableRuntime; generationKeyPrefix?: string;
}) {
  const ids = [...new Set(args.assetIds)];
  if (!ids.length) throw new ProductionImageError("assetIds不能为空");
  const settings = await projectSettings(db, args.projectId);
  const prepared = await withProjectTransaction(db, args.projectId, async (trx) => {
    await assertEpisode(trx, args.projectId, args.scriptId);
    const assets = await trx("o_assets").whereIn("id", ids);
    if (assets.length !== ids.length || assets.some((asset) => Number(asset.projectId) !== args.projectId)) throw new ProductionImageError("资产不属于当前项目", 404);
    const links = await trx("o_scriptAssets").where({ scriptId: args.scriptId }).whereIn("assetId", ids);
    if (links.length !== ids.length) throw new ProductionImageError("资产不属于当前剧集", 400);
    const parentIds = [...new Set(assets.map((asset) => asset.assetsId).filter((id): id is number => id != null))];
    const parents = parentIds.length ? await trx("o_assets").leftJoin("o_image", "o_assets.imageId", "o_image.id").whereIn("o_assets.id", parentIds).andWhere("o_assets.projectId", args.projectId).select("o_assets.id", "o_assets.imageId", "o_assets.describe", "o_image.filePath", "o_image.state") : [];
    if (parents.length !== parentIds.length) throw new ProductionImageError("父资产不属于当前项目", 400);
    for (const parent of parents) if (parent.imageId != null && !parent.filePath) throw new ProductionImageError("父资产图片原材料不存在", 400);
    for (const parent of parents) if (parent.imageId != null && parent.state === "生成中") throw new ProductionImageError("父资产图片正在生成中，请稍后重试", 409);
    for (const asset of assets) await assertAssetWritable(trx, Number(asset.id));
    return { assets, parents };
  });
  const parentBase64 = new Map<number, string>();
  for (const parent of prepared.parents) if (parent.filePath) parentBase64.set(Number(parent.id), await args.runtime.getImageBase64(String(parent.filePath)));
  const prefix = args.generationKeyPrefix ?? `web-derived:${args.projectId}:${args.scriptId}:${args.runtime.uuid()}`;
  const keys = new Map(ids.map((id) => [id, `${prefix}:asset:${id}`]));
  const receipts = new Map<number, ImageGenerationReceipt>();
  const preparationFailures = new Map<number, string>();
  await bounded(prepared.assets, args.concurrentCount ?? 5, async (asset) => {
    const id = Number(asset.id);
    try {
      const referenceList = asset.assetsId != null && parentBase64.has(Number(asset.assetsId)) ? [{ type: "image" as const, base64: parentBase64.get(Number(asset.assetsId))! }] : [];
      const existing = await findGeneration(args.runtime.imageJobs, args.projectId, keys.get(id)!);
      if (existing) {
        const current = await db("o_assets").where({ id, projectId: args.projectId }).first();
        if (!current) throw new ProductionImageError("资产已被删除", 404);
        receipts.set(id, await args.runtime.imageJobs.prepare({
          generationKey: keys.get(id)!, projectId: args.projectId, modelKey: String(settings.imageModel),
          config: { prompt: String(current.prompt ?? ""), referenceList, size: String(settings.imageQuality), aspectRatio: "16:9" },
          target: { kind: "asset", id, scriptId: args.scriptId, expectedVersion: existing.target.expectedVersion },
        }));
        return;
      }
      const current = await db("o_assets").where({ id, projectId: args.projectId }).first();
      if (!current || String(current.describe ?? "") !== String(asset.describe ?? "") || Number(current.imageId ?? 0) !== Number(asset.imageId ?? 0)) throw new ProductionImageError("资产已被其他操作修改，已停止图片生成", 409);
      const type = String(asset.type || "role");
      const prompt = await args.runtime.generatePrompt({
        system: args.runtime.getArtPrompt(String(settings.artStyle || "无"), "art_skills", promptFileByType[type] || promptFileByType.role),
        parentDescription: String(asset.assetsId ? prepared.parents.find((parent) => Number(parent.id) === Number(asset.assetsId))?.describe || "无详细描述" : "无详细描述"),
        description: String(asset.describe || "无详细描述"),
      });
      const updated = await db("o_assets").where({ id, projectId: args.projectId, imageId: asset.imageId ?? null, describe: asset.describe ?? null }).update({ prompt });
      if (updated !== 1) throw new ProductionImageError("资产已被其他操作修改，已停止图片生成", 409);
      receipts.set(id, await args.runtime.imageJobs.prepare({
        generationKey: keys.get(id)!, projectId: args.projectId, modelKey: String(settings.imageModel),
        config: { prompt, referenceList, size: String(settings.imageQuality), aspectRatio: "16:9" },
        target: { kind: "asset", id, scriptId: args.scriptId },
      }));
    } catch (error) {
      const errorReason = messageOf(error);
      preparationFailures.set(id, errorReason);
      await insertRowsReturningIds(db, "o_image", { assetsId: id, type: asset.type, state: "生成失败", errorReason, model: String(settings.imageModel).split(/:(.+)/)[1], resolution: settings.imageQuality });
    }
  });
  const preview = prepared.assets.map((asset) => ({
    id: Number(asset.id), name: asset.name ?? "", type: asset.type ?? "",
    state: preparationFailures.has(Number(asset.id)) ? "生成失败" : "生成中", src: "",
    ...(preparationFailures.has(Number(asset.id)) ? { errorReason: preparationFailures.get(Number(asset.id)) } : {}),
  }));
  const run = async () => {
    const results: Array<{ id: number; state: string; src: string; errorReason?: string; jobId?: number }> = [];
    await bounded(prepared.assets, args.concurrentCount ?? 5, async (asset) => {
      const id = Number(asset.id);
      try {
        const errorReason = preparationFailures.get(id);
        if (errorReason) { results.push({ id, state: "生成失败", src: "", errorReason }); return; }
        const preparedReceipt = receipts.get(id)!;
        const receipt = await args.runtime.imageJobs.submitAndWait({ projectId: args.projectId, jobId: preparedReceipt.jobId });
        results.push(await durableResult(args.runtime, id, receipt));
      } catch (error) {
        const errorReason = messageOf(error);
        results.push({ id, state: "生成失败", src: "", errorReason });
      }
    });
    notifyProductionChange({ projectId: args.projectId, scriptId: args.scriptId });
    return results;
  };
  notifyProductionChange({ projectId: args.projectId, scriptId: args.scriptId });
  return { preview, run };
}

async function prepareDurableStoryboardImages(db: Knex, args: {
  projectId: number; scriptId: number; storyboardIds: number[]; concurrentCount?: number; compulsory?: boolean; runtime: DurableRuntime; generationKeyPrefix?: string;
}) {
  const ids = [...new Set(args.storyboardIds)];
  if (!ids.length) throw new ProductionImageError("storyboardIds不能为空");
  const settings = await projectSettings(db, args.projectId);
  const prepared = await withProjectTransaction(db, args.projectId, async (trx) => {
    await assertEpisode(trx, args.projectId, args.scriptId);
    const storyboards = await trx("o_storyboard").where({ projectId: args.projectId, scriptId: args.scriptId }).whereIn("id", ids);
    if (storyboards.length !== ids.length) throw new ProductionImageError("分镜不属于当前项目或剧集", 404);
    const locked = await trx("ext_entity_state").where({ entityType: "storyboard", locked: 1 }).whereIn("entityId", ids).first();
    if (locked) throw new ProductionImageError("锁定分镜不能生成图片", 423);
    const links = await trx("o_assets2Storyboard").whereIn("storyboardId", ids).orderBy(isPostgres(trx) ? "id" : "rowid");
    const assetIds = [...new Set(links.map((row) => Number(row.assetId)))];
    const assets = assetIds.length ? await trx("o_assets").whereIn("id", assetIds) : [];
    if (assets.length !== assetIds.length || assets.some((asset) => Number(asset.projectId) !== args.projectId)) throw new ProductionImageError("分镜引用素材不属于当前项目", 400);
    const missingImages = assets.filter((asset) => asset.imageId == null);
    if (missingImages.length) throw new ProductionImageError(`请先生成并选用引用素材的图片：${missingImages.map((asset) => asset.name || `ID ${asset.id}`).join("、")}`, 400);
    const imageIds = [...new Set(assets.map((asset) => asset.imageId).filter((id): id is number => id != null).map(Number))];
    const images = imageIds.length ? await trx("o_image").whereIn("id", imageIds) : [];
    if (images.length !== imageIds.length || images.some((image) => !image.filePath)) throw new ProductionImageError("分镜引用的图片原材料不存在", 400);
    if (images.some((image) => image.state === "生成中")) throw new ProductionImageError("分镜引用图片正在生成中，请稍后重试", 409);
    const states = await trx("ext_entity_state").where({ entityType: "storyboard" }).whereIn("entityId", ids);
    return { storyboards, links, assets, images, stateVersions: new Map(states.map((state) => [Number(state.entityId), Number(state.version)])) };
  });
  const imageBase64 = new Map<number, string>();
  for (const image of prepared.images) imageBase64.set(Number(image.id), await args.runtime.getImageBase64(String(image.filePath)));
  const currentRows = await db("o_storyboard").where({ projectId: args.projectId, scriptId: args.scriptId }).whereIn("id", ids);
  if (currentRows.length !== prepared.storyboards.length || currentRows.some((row) => {
    const original = prepared.storyboards.find((item) => Number(item.id) === Number(row.id));
    return !original || String(row.prompt ?? "") !== String(original.prompt ?? "") || String(row.filePath ?? "") !== String(original.filePath ?? "");
  })) throw new ProductionImageError("分镜已被其他操作修改，请重新载入", 409);
  const currentAssets = prepared.assets.length ? await db("o_assets").where({ projectId: args.projectId }).whereIn("id", prepared.assets.map((row) => row.id)) : [];
  if (currentAssets.some((current) => Number(current.imageId ?? 0) !== Number(prepared.assets.find((row) => Number(row.id) === Number(current.id))?.imageId ?? 0))) throw new ProductionImageError("分镜引用图片已被其他操作修改，请重新载入", 409);
  const assetById = new Map(prepared.assets.map((asset) => [Number(asset.id), asset]));
  const prefix = args.generationKeyPrefix ?? `web-storyboard:${args.projectId}:${args.scriptId}:${args.runtime.uuid()}`;
  const generateList = args.compulsory ? prepared.storyboards : prepared.storyboards.filter((row) => row.shouldGenerateImage !== 0);
  const receipts = new Map<number, ImageGenerationReceipt>();
  try {
  for (const row of generateList) {
    const referenceList = prepared.links.filter((link) => Number(link.storyboardId) === Number(row.id)).map((link) => assetById.get(Number(link.assetId))).filter(Boolean).map((asset) => ({ type: "image" as const, base64: imageBase64.get(Number(asset!.imageId))! }));
    const generationKey = `${prefix}:storyboard:${row.id}`;
    const existing = await findGeneration(args.runtime.imageJobs, args.projectId, generationKey);
    const receipt = await args.runtime.imageJobs.prepare({
      generationKey, projectId: args.projectId, modelKey: String(settings.imageModel),
      config: { prompt: String(row.prompt || ""), referenceList, size: String(settings.imageQuality), aspectRatio: String(settings.videoRatio || "16:9") },
      target: { kind: "storyboard", id: Number(row.id), scriptId: args.scriptId, expectedVersion: existing?.target.expectedVersion ?? prepared.stateVersions.get(Number(row.id)) ?? 0 },
    });
    receipts.set(Number(row.id), receipt);
  }
  } catch (error) {
    await Promise.all([...receipts.values()].map((receipt) => args.runtime.imageJobs.cancelPrepared({ projectId: args.projectId, jobId: receipt.jobId, reason: `本批次准备失败，未提交图片生成：${messageOf(error)}` })));
    notifyProductionChange({ projectId: args.projectId, scriptId: args.scriptId });
    throw error;
  }
  const preview = prepared.storyboards.map((row) => ({
    id: Number(row.id), prompt: row.prompt ?? "", videoDesc: row.videoDesc ?? "", shouldGenerateImage: row.shouldGenerateImage,
    state: receipts.has(Number(row.id)) ? "生成中" : row.state, src: row.filePath ?? null,
    associateAssetsIds: prepared.links.filter((link) => Number(link.storyboardId) === Number(row.id)).map((link) => Number(link.assetId)),
  }));
  const run = async () => {
    const results: Array<{ id: number; state: string; src: string; errorReason?: string; jobId?: number }> = [];
    await bounded(generateList, args.concurrentCount ?? 5, async (row) => {
      try {
        const preparedReceipt = receipts.get(Number(row.id))!;
        const receipt = await args.runtime.imageJobs.submitAndWait({ projectId: args.projectId, jobId: preparedReceipt.jobId });
        results.push(await durableResult(args.runtime, Number(row.id), receipt));
      } catch (error) {
        results.push({ id: Number(row.id), state: "生成失败", src: "", errorReason: messageOf(error) });
      }
    });
    notifyProductionChange({ projectId: args.projectId, scriptId: args.scriptId });
    return results;
  };
  notifyProductionChange({ projectId: args.projectId, scriptId: args.scriptId });
  return { preview, run };
}

async function durableResult(runtime: ProductionImageRuntime, id: number, receipt: ImageGenerationReceipt) {
  if (receipt.status === "succeeded" && receipt.artifactPath) return { id, state: "已完成", src: await runtime.getSmallImageUrl(receipt.artifactPath), jobId: receipt.jobId };
  if (receipt.status === "pending") return { id, state: "生成中", src: "", jobId: receipt.jobId };
  return { id, state: "生成失败", src: "", errorReason: receipt.error ?? (receipt.status === "needs_reconciliation" ? "图片任务需要人工核对" : "图片生成失败"), jobId: receipt.jobId };
}

async function findGeneration(jobs: ImageGenerationService, projectId: number, generationKey: string): Promise<ImageGenerationReceipt | undefined> {
  try { return await jobs.get({ projectId, generationKey }); }
  catch (error) { if (error instanceof ImageGenerationError && error.code === "NOT_FOUND") return undefined; throw error; }
}
