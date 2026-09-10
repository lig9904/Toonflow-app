import type { Knex } from "knex";

export interface ImageReferenceSnapshot {
  assetId: number; parentAssetId: number | null; imageId: number; name: string; description: string; filePath: string;
}

export function snapshotImageReference(asset: any, filePath: string): ImageReferenceSnapshot {
  return { assetId: Number(asset.id), parentAssetId: asset.assetsId == null ? null : Number(asset.assetsId), imageId: Number(asset.imageId),
    name: String(asset.name ?? ""), description: String(asset.describe ?? asset.desc ?? ""), filePath };
}

/** Check both identity metadata and the selected image, before reservation and
 * again before a late result is allowed to replace the canvas. */
export async function imageReferencesMatch(db: Knex | Knex.Transaction, projectId: number, snapshots?: ImageReferenceSnapshot[]): Promise<boolean> {
  if (!snapshots?.length) return true; // Historical jobs did not record these.
  const rows = await db("o_assets as asset").join("o_image as image", "image.id", "asset.imageId")
    .where("asset.projectId", projectId).whereIn("asset.id", snapshots.map((item) => item.assetId))
    .select("asset.*", "image.filePath", "image.state as imageState");
  return snapshots.every((snapshot) => {
    const row = rows.find((item) => Number(item.id) === snapshot.assetId);
    if (!row || row.imageState === "生成中") return false;
    const current = snapshotImageReference(row, String(row.filePath ?? ""));
    return (Object.keys(current) as Array<keyof ImageReferenceSnapshot>).every((key) => current[key] === snapshot[key]);
  });
}
