import type { Knex } from "knex";
import { withProjectTransaction, isPostgres } from "../lib/dbTransaction";
import { reconcileStoryboardAssetIds, StoryboardVisualError } from "../lib/storyboardVisualContract";
import { ProductionStateService } from "./productionState";

/** Repair a known missing identity only when preparing a new generation. Existing
 * jobs keep their immutable requests. The project lock and storyboard version
 * prevent an old agent snapshot from editing a newer canvas. */
export async function reconcileStoredStoryboardReferences(db: Knex, input: {
  projectId: number; scriptId: number; storyboardIds: number[]; expectedVersions?: Record<number, number>;
}): Promise<Record<number, number>> {
  return withProjectTransaction(db, input.projectId, async (trx) => {
    const episode = await trx("o_script").where({ id: input.scriptId, projectId: input.projectId }).first();
    if (!episode) throw new StoryboardVisualError("分镜剧集不属于当前项目", 404);
    const ids = [...new Set(input.storyboardIds)];
    const rows = await trx("o_storyboard").where({ projectId: input.projectId, scriptId: input.scriptId }).whereIn("id", ids);
    if (rows.length !== ids.length) throw new StoryboardVisualError("分镜不属于当前项目或剧集", 404);
    const links = await trx("o_assets2Storyboard").whereIn("storyboardId", ids).orderBy(isPostgres(trx) ? "id" : "rowid");
    const episodeLinks = await trx("o_scriptAssets").where({ scriptId: input.scriptId });
    const scope = [...new Set([...links.map((row) => Number(row.assetId)), ...episodeLinks.map((row) => Number(row.assetId))])];
    const assets = await trx("o_assets").where({ projectId: input.projectId }).andWhere((query) => query.whereIn("id", scope).orWhereIn("assetsId", scope));
    const versions: Record<number, number> = {};
    for (const row of rows) {
      const state = await trx("ext_entity_state").where({ entityType: "storyboard", entityId: row.id, projectId: input.projectId }).first();
      const version = Number(state?.version ?? 0);
      if (state?.locked) throw new StoryboardVisualError("锁定分镜不能生成图片或自动修复引用", 423);
      if (input.expectedVersions?.[row.id] !== undefined && input.expectedVersions[row.id] !== version) throw new StoryboardVisualError("分镜已被人工或其他任务修改，本次旧请求已停止", 409);
      const original = links.filter((link) => Number(link.storyboardId) === Number(row.id)).map((link) => Number(link.assetId));
      const repaired = reconcileStoryboardAssetIds({ ...row, associateAssetsIds: original }, assets);
      const added = repaired.filter((id) => !original.includes(id));
      const removed = original.filter((id) => !repaired.includes(id));
      if (added.length || removed.length) {
        await new ProductionStateService(trx as unknown as Knex).guardStoryboardMutations({
          projectId: input.projectId, storyboardIds: [Number(row.id)], expectedVersions: { [row.id]: version },
          actor: { kind: "agent", id: "system:storyboard-reference-repair" },
          mutate: async (guarded) => {
            if (removed.length) await guarded("o_assets2Storyboard").where({ storyboardId: row.id }).whereIn("assetId", removed).delete();
            if (added.length) await guarded("o_assets2Storyboard").insert(added.map((assetId) => ({ storyboardId: row.id, assetId })));
          },
        });
      }
      versions[Number(row.id)] = Number((await trx("ext_entity_state").where({ entityType: "storyboard", entityId: row.id }).first())?.version ?? version);
    }
    return versions;
  });
}
