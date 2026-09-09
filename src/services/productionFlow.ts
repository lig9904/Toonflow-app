import { insertRowsReturningIds } from "../lib/insertRows";
import { isPostgres, withProjectTransaction } from "../lib/dbTransaction";
import type { Knex } from "knex";

export class ProductionFlowError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export async function assertEpisode(db: Knex | Knex.Transaction, projectId: number, scriptId: number) {
  const script = await db("o_script").where({ id: scriptId, projectId }).first();
  if (!script) throw new ProductionFlowError("剧集不属于当前项目", 404);
  return script;
}

/** Cached planning is supplementary; relational rows own creative entities. */
export async function readProductionFlow(db: Knex, projectId: number, scriptId: number, getUrl: (path: string) => Promise<string>) {
  const rows = await db.transaction(async (trx) => {
    if (isPostgres(trx)) await trx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const script = await assertEpisode(trx, projectId, scriptId);
    const saved = await trx("o_agentWorkData").where({ projectId, episodesId: scriptId, key: "productionAgent" }).first();
    const refs = await trx("o_scriptAssets").where({ scriptId });
    const ids = refs.map((row) => row.assetId);
    const assets = await trx("o_assets").leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .select("o_assets.*", "o_image.filePath", "o_image.state", "o_image.errorReason")
      .where("o_assets.projectId", projectId)
      .andWhere((query) => query.whereIn("o_assets.id", ids).orWhereIn("o_assets.assetsId", ids));
    const storyboards = await trx("o_storyboard").where({ scriptId }).orderBy("index").orderBy("id");
    const links = await trx("o_assets2Storyboard").whereIn("storyboardId", storyboards.map((row) => row.id)).orderBy(isPostgres(trx) ? "id" : "rowid");
    const states = await trx("ext_entity_state").where({ projectId, entityType: "storyboard" })
      .whereIn("entityId", storyboards.map((row) => row.id));
    const assetStates = await trx.schema.hasTable("ext_creative_state") ? await trx("ext_creative_state").where({ projectId, entityType: "asset" }).whereIn("entityId", assets.map((row) => row.id)) : [];
    return { script, saved, assets, storyboards, links, states, assetStates };
  });
  let cached: Record<string, any> = {};
  try { cached = JSON.parse(rows.saved?.data || "{}"); } catch { /* damaged planning must not hide existing entities */ }
  if (!cached || typeof cached !== "object" || Array.isArray(cached)) cached = {};
  const url = async (file: string | null) => { try { return file ? await getUrl(file) : ""; } catch { return ""; } };
  const shapeAsset = async (row: any) => ({
    id: row.id, assetsId: row.assetsId, imageId: row.imageId, name: row.name ?? "", type: row.type ?? "", prompt: row.prompt ?? "",
    version: Number(rows.assetStates.find((state) => Number(state.entityId) === Number(row.id))?.version ?? 0),
    desc: row.describe ?? "", src: await url(row.filePath), flowId: row.flowId,
    state: row.state ?? "未生成", errorReason: row.errorReason ?? "",
  });
  const assets = await Promise.all(rows.assets.filter((row) => row.assetsId == null).map(async (row) => ({
    ...await shapeAsset(row), derive: await Promise.all(rows.assets.filter((child) => child.assetsId === row.id).map(shapeAsset)),
  })));
  const storyboard = await Promise.all(rows.storyboards.map(async (row) => {
    const state = rows.states.find((item) => item.entityId === row.id);
    return {
      id: row.id, index: row.index, duration: Number(row.duration) || 0, prompt: row.prompt ?? "",
      associateAssetsIds: rows.links.filter((item) => item.storyboardId === row.id).map((item) => item.assetId),
      src: await url(row.filePath), state: row.state, videoDesc: row.videoDesc ?? "", shouldGenerateImage: row.shouldGenerateImage,
      reason: row.reason ?? "", flowId: row.flowId, trackId: row.trackId,
      collaboration: { entityType: "storyboard", entityId: row.id, projectId, version: state?.version ?? 0,
        reviewState: state?.reviewState ?? "draft", locked: Boolean(state?.locked), lockedBy: state?.lockedBy ?? null,
        updatedBy: state?.updatedBy ?? null, updatedAt: state?.updatedAt ?? null },
    };
  }));
  return {
    planningVersion: Number.isSafeInteger(cached.planningVersion) ? cached.planningVersion : 0,
    script: rows.script.content ?? "", scriptPlan: typeof cached.scriptPlan === "string" ? cached.scriptPlan : "",
    storyboardTable: typeof cached.storyboardTable === "string" ? cached.storyboardTable : "",
    assets, storyboard, workbench: { videoList: [] },
  };
}

export interface NewStoryboard {
  prompt: string; duration: number; track: string; videoDesc: string; shouldGenerateImage: number; associateAssetsIds: number[];
}
/** Shared by browser and internal agent: commit first, notify afterwards. */
export async function addProductionStoryboards(db: Knex, projectId: number, scriptId: number, items: NewStoryboard[]) {
  return withProjectTransaction(db, projectId, async (trx) => {
    await assertEpisode(trx, projectId, scriptId);
    const assetIds = [...new Set(items.flatMap((item) => item.associateAssetsIds))];
    const assets = await trx("o_assets").where({ projectId }).whereIn("id", assetIds);
    if (assets.length !== assetIds.length) throw new ProductionFlowError("引用素材不属于当前项目");
    const last = await trx("o_storyboard").where({ scriptId }).max("index as last").first();
    let index = Number(last?.last ?? -1) + 1;
    const inserted: number[] = [];
    for (const item of items) {
      const existing = await trx("o_storyboard").where({ scriptId, track: item.track }).whereNotNull("trackId").first();
      let trackId = existing?.trackId;
      if (!trackId) [trackId] = await insertRowsReturningIds(trx, "o_videoTrack", { scriptId, projectId, duration: 0 });
      const [id] = await insertRowsReturningIds(trx, "o_storyboard", {
        projectId, scriptId, trackId, track: item.track, index: index++, prompt: item.prompt, duration: String(item.duration),
        videoDesc: item.videoDesc, shouldGenerateImage: item.shouldGenerateImage, state: "未生成", createTime: Date.now(),
      });
      if (item.associateAssetsIds.length) await trx("o_assets2Storyboard").insert(
        [...new Set(item.associateAssetsIds)].map((assetId) => ({ assetId, storyboardId: id })),
      );
      const total = await trx("o_storyboard").where({ scriptId, trackId }).sum("duration as total").first();
      await trx("o_videoTrack").where({ id: trackId, scriptId, projectId }).update({ duration: Number(total?.total) || 0 });
      inserted.push(id);
    }
    return inserted;
  });
}


export async function saveProductionPlanning(db: Knex, projectId: number, scriptId: number, expectedPlanningVersion: number, data: {
  scriptPlan: string; storyboardTable: string; storyboard?: Array<{ id?: number; collaboration?: { version: number } }>;
}) {
  return withProjectTransaction(db, projectId, async (trx) => {
    await assertEpisode(trx, projectId, scriptId);
    const key = { projectId, episodesId: scriptId, key: "productionAgent" };
    const saved = await trx("o_agentWorkData").where(key).first();
    let cached: Record<string, any> = {};
    try { cached = JSON.parse(saved?.data || "{}"); } catch { /* permit repair with version zero */ }
    if (!cached || typeof cached !== "object" || Array.isArray(cached)) cached = {};
    const version = Number.isSafeInteger(cached.planningVersion) ? cached.planningVersion : 0;
    if (version !== expectedPlanningVersion) throw new ProductionFlowError("制作规划已被其他客户端修改，请重新载入", 409);
    const storyboardVersions: Record<number, number> = {};
    let reordered = false;
    if (data.storyboard?.length && data.storyboard.every((item) => item.id)) {
      const rows = await trx("o_storyboard").where({ scriptId }).orderBy("index").orderBy("id");
      if (rows.some((row) => Number(row.projectId) !== projectId)) throw new ProductionFlowError("分镜项目归属不一致，请检查后重新载入", 409);
      const ids = data.storyboard.map((item) => item.id!);
      if (new Set(ids).size !== ids.length || rows.length !== ids.length || rows.some((row) => !ids.includes(row.id))) {
        throw new ProductionFlowError("分镜列表已变化，请重新载入", 409);
      }
      const orderUnchanged = data.storyboard.every((item, index) => rows[index]?.id === item.id);
      for (const [index, item] of data.storyboard.entries()) {
        const row = rows.find((row) => row.id === item.id)!;
        // Preserve untouched legacy rows with a null/non-contiguous index.
        if (orderUnchanged || row.index === index) continue;
        const state = await trx("ext_entity_state").where({ entityType: "storyboard", entityId: item.id }).first();
        if (item.collaboration?.version !== (state?.version ?? 0)) throw new ProductionFlowError("分镜已变化，请重新载入后排序", 409);
        if (state?.locked) throw new ProductionFlowError("锁定分镜不能重新排序", 423);
        await trx("o_storyboard").where({ id: item.id, scriptId }).update({ index });
        storyboardVersions[item.id!] = (await trx("ext_entity_state").where({ entityType: "storyboard", entityId: item.id }).first())?.version ?? 0;
        reordered = true;
      }
    }
    const changed = reordered || (cached.scriptPlan ?? "") !== data.scriptPlan || (cached.storyboardTable ?? "") !== data.storyboardTable;
    const planningVersion = changed ? version + 1 : version;
    if (changed || !saved) {
      const document = JSON.stringify({ scriptPlan: data.scriptPlan, storyboardTable: data.storyboardTable, planningVersion });
      if (saved) await trx("o_agentWorkData").where({ id: saved.id }).update({ data: document });
      else await trx("o_agentWorkData").insert({ ...key, data: document });
    }
    return { planningVersion, storyboardVersions };
  });
}
