import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { loadVolcengineAssetCredentials, readVolcengineBindingSnapshots, resolveCurrentVolcengineReference,
  VolcengineTrustedAssetClient, type VolcengineBindingSnapshot } from "./volcengineTrustedAssets";

export interface TrustedReferenceSource { projectId: number; scriptId: number; id: number; sources: "assets" | "storyboard"; fileType?: "image" | "video" | "audio" }
export const isVolcengineTrustedModel = (model: string | undefined) => model?.startsWith("volcengineSd2:") === true;
export const referenceSourceHash = (toBase64: (path: string) => Promise<string>) => async (path: string) => createHash("sha256").update(await toBase64(path)).digest("hex");

export function readPromptTrustedBindings(db: Knex, projectId: number, scriptId: number, info: Array<{ id: number; sources: string; fileType?: string }>) {
  return readVolcengineBindingSnapshots(db, { projectId, scriptId, refs: info.map((item) => {
    if (!["assets", "storyboard"].includes(item.sources)) throw new Error("火山素材引用来源无效");
    return { id: item.id, sources: item.sources as "assets" | "storyboard", fileType: item.fileType as "image" | "video" | "audio" | undefined };
  }) });
}

export async function loadTrustedVideoReference(db: Knex, source: TrustedReferenceSource, toBase64: (path: string) => Promise<string>) {
  const snapshots = await readVolcengineBindingSnapshots(db, { ...source, refs: [source] });
  if (!snapshots.length) return undefined;
  const client = new VolcengineTrustedAssetClient({ credentials: await loadVolcengineAssetCredentials(db) });
  const resolved = await resolveCurrentVolcengineReference(db, client, { ...source, targetKind: source.sources === "assets" ? "asset" : "storyboard", targetId: source.id }, snapshots[0], referenceSourceHash(toBase64));
  if (!resolved) throw new Error("火山素材绑定已变化，请重新选择参考素材");
  if (source.fileType && source.fileType !== resolved.type) throw new Error("火山素材类型与本次引用类型不一致");
  return { type: resolved.type, url: resolved.url, source, trustedAsset: resolved.snapshot };
}

/** No generation has been submitted when this guard runs. Never substitute a newly changed binding. */
export async function revalidateTrustedVideoReferences(db: Knex, modelKey: string, config: unknown, toBase64: (path: string) => Promise<string>): Promise<void> {
  if (!isVolcengineTrustedModel(modelKey) || !config || typeof config !== "object") return;
  const refs = (config as { referenceList?: unknown }).referenceList;
  if (!Array.isArray(refs)) return;
  try {
    let client: VolcengineTrustedAssetClient | undefined;
    for (const reference of refs) {
      const source = reference?.source as TrustedReferenceSource | undefined;
      if (!source) {
        if (String(reference?.url ?? "").startsWith("asset://")) throw new Error("火山引用缺少本地绑定来源，未提交视频");
        continue;
      }
      const snapshots = await readVolcengineBindingSnapshots(db, { ...source, refs: [source] });
      const expected = reference.trustedAsset as VolcengineBindingSnapshot | undefined;
      if (!expected && !snapshots.length) continue;
      if (!expected || !snapshots.length) throw new Error("视频保留后火山素材绑定已变化，请重新发起生成");
      client ??= new VolcengineTrustedAssetClient({ credentials: await loadVolcengineAssetCredentials(db) });
      const current = await resolveCurrentVolcengineReference(db, client, { ...source, targetKind: source.sources === "assets" ? "asset" : "storyboard", targetId: source.id }, expected, referenceSourceHash(toBase64));
      if (!current || current.url !== reference.url || current.type !== reference.type) throw new Error("火山素材引用与保留任务不一致，未提交视频");
      const after = await readVolcengineBindingSnapshots(db, { ...source, refs: [source] }, referenceSourceHash(toBase64));
      if (JSON.stringify(after[0]) !== JSON.stringify(current.snapshot)) throw new Error("核验期间火山素材绑定发生变化，未提交视频");
    }
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("火山素材引用核验失败"), { submissionOutcome: "not_submitted" });
  }
}
