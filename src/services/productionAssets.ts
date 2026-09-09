import { insertRowsReturningIds } from "../lib/insertRows";
import { withProjectTransaction } from "../lib/dbTransaction";
import type { Knex } from "knex";
import { notifyProductionChange } from "./productionEvents";

export class ProductionAssetError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "ProductionAssetError";
  }
}

export interface DerivedAssetInput {
  projectId: number;
  scriptId: number;
  parentAssetId: number;
  id?: number | null;
  name: string;
  description: string;
}

async function assertEpisode(db: Knex | Knex.Transaction, projectId: number, scriptId: number): Promise<void> {
  const script = await db("o_script").where({ id: scriptId, projectId }).first();
  if (!script) throw new ProductionAssetError("剧集不属于当前项目", 404);
}

async function assertParentBinding(db: Knex.Transaction, input: DerivedAssetInput): Promise<any> {
  await assertEpisode(db, input.projectId, input.scriptId);
  const parent = await db("o_assets").where({ id: input.parentAssetId, projectId: input.projectId }).first();
  if (!parent) throw new ProductionAssetError("父资产不属于当前项目", 404);
  const linked = await db("o_scriptAssets").where({ scriptId: input.scriptId, assetId: input.parentAssetId }).first();
  if (!linked) throw new ProductionAssetError("父资产未绑定到当前剧集", 400);
  return parent;
}

export async function assertAssetNotLockedReference(db: Knex.Transaction, assetId: number): Promise<void> {
  const lockedReference = await db("o_assets2Storyboard as link")
    .join("ext_entity_state as state", function () {
      this.on("state.entityType", "=", db.raw("?", ["storyboard"]))
        .andOn("state.entityId", "=", "link.storyboardId")
        .andOn("state.locked", "=", db.raw("?", [1]));
    })
    .where("link.assetId", assetId)
    .first();
  if (lockedReference) throw new ProductionAssetError("锁定分镜引用了该资产，不能修改或删除", 423);
}

export async function createOrUpdateDerivedAsset(db: Knex, input: DerivedAssetInput) {
  const result = await withProjectTransaction(db, input.projectId, async (trx) => {
    const parent = await assertParentBinding(trx, input);
    const values = {
      assetsId: input.parentAssetId,
      projectId: input.projectId,
      name: input.name,
      type: parent.type,
      describe: input.description,
      startTime: Date.now(),
    };
    if (input.id != null) {
      const child = await trx("o_assets").where({ id: input.id, projectId: input.projectId, assetsId: input.parentAssetId }).first();
      if (!child) throw new ProductionAssetError("衍生资产不属于当前项目、剧集或父资产", 404);
      if (!(await trx("o_scriptAssets").where({ scriptId: input.scriptId, assetId: input.id }).first())) throw new ProductionAssetError("衍生资产未绑定到当前剧集", 400);
      await assertAssetNotLockedReference(trx, Number(input.id));
      await trx("o_assets").where({ id: input.id, projectId: input.projectId, assetsId: input.parentAssetId }).update(values);
      return { id: Number(input.id), created: false, parentAssetId: input.parentAssetId };
    }
    const [id] = await insertRowsReturningIds(trx, "o_assets", { ...values, scriptId: input.scriptId });
    await trx("o_scriptAssets").insert({ scriptId: input.scriptId, assetId: id });
    return { id: Number(id), created: true, parentAssetId: input.parentAssetId };
  });
  notifyProductionChange({ projectId: input.projectId, scriptId: input.scriptId });
  return result;
}

export async function deleteDerivedAsset(db: Knex, input: { projectId: number; scriptId: number; parentAssetId: number; id: number }) {
  const result = await withProjectTransaction(db, input.projectId, async (trx) => {
    await assertEpisode(trx, input.projectId, input.scriptId);
    const child = await trx("o_assets").where({ id: input.id, projectId: input.projectId, assetsId: input.parentAssetId }).first();
    if (!child) throw new ProductionAssetError("衍生资产不属于当前项目、剧集或父资产", 404);
    if (!(await trx("o_scriptAssets").where({ scriptId: input.scriptId, assetId: input.id }).first())) throw new ProductionAssetError("衍生资产未绑定到当前剧集", 400);
    const parent = await trx("o_assets").where({ id: input.parentAssetId, projectId: input.projectId }).first();
    if (!parent) throw new ProductionAssetError("父资产不属于当前项目", 404);
    const parentLink = await trx("o_scriptAssets").where({ scriptId: input.scriptId, assetId: input.parentAssetId }).first();
    if (!parentLink) throw new ProductionAssetError("父资产未绑定到当前剧集", 400);

    await assertAssetNotLockedReference(trx, input.id);

    const flowId = child.flowId;
    await trx("o_assets2Storyboard").where({ assetId: input.id }).del();
    await trx("o_scriptAssets").where({ scriptId: input.scriptId, assetId: input.id }).del();
    await trx("o_image").where({ assetsId: input.id }).del();
    await trx("o_assets").where({ id: input.id, projectId: input.projectId }).del();
    if (flowId != null && !(await trx("o_assets").where({ flowId }).first())) await trx("o_imageFlow").where({ id: flowId }).del();
    return { id: input.id, deleted: true };
  });
  notifyProductionChange({ projectId: input.projectId, scriptId: input.scriptId });
  return result;
}

export async function updateDerivedAssetImage(db: Knex, input: { projectId: number; scriptId: number; id: number; url: string; flowId: number }) {
  const result = await withProjectTransaction(db, input.projectId, async (trx) => {
    await assertEpisode(trx, input.projectId, input.scriptId);
    const child = await trx("o_assets").where({ id: input.id, projectId: input.projectId }).whereNotNull("assetsId").first();
    if (!child) throw new ProductionAssetError("衍生资产不属于当前项目或剧集", 404);
    if (!(await trx("o_scriptAssets").where({ scriptId: input.scriptId, assetId: input.id }).first())) throw new ProductionAssetError("衍生资产未绑定到当前剧集", 400);
    const parent = await trx("o_assets").where({ id: child.assetsId, projectId: input.projectId }).first();
    if (!parent) throw new ProductionAssetError("父资产不属于当前项目", 404);
    if (!(await trx("o_scriptAssets").where({ scriptId: input.scriptId, assetId: child.assetsId }).first())) throw new ProductionAssetError("父资产未绑定到当前剧集", 400);
    await assertAssetNotLockedReference(trx, input.id);
    const [imageId] = await insertRowsReturningIds(trx, "o_image", { filePath: input.url, state: "已完成", assetsId: input.id, type: child.type });
    await trx("o_assets").where({ id: input.id, projectId: input.projectId }).update({ flowId: input.flowId, imageId });
    return { id: input.id, imageId, flowId: input.flowId };
  });
  notifyProductionChange({ projectId: input.projectId, scriptId: input.scriptId });
  return result;
}
