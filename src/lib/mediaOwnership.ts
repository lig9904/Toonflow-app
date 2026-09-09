import type { Knex } from "knex";

export class MediaOwnershipError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "PROJECT_MISMATCH" | "AMBIGUOUS_OWNER",
    message: string,
  ) {
    super(message);
    this.name = "MediaOwnershipError";
  }
}

export interface MediaOwnership {
  filePath: string;
  projectId: number;
  sources: string[];
}

export function canonicalMediaPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)) {
    throw new MediaOwnershipError("INVALID_INPUT", "图片路径无效");
  }
  let path = value.trim();
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    throw new MediaOwnershipError("INVALID_INPUT", "图片路径无效");
  }
  path = path.split("?")[0].split("#")[0];
  if (path === "/smallImage" || path.startsWith("/smallImage/")) path = path.slice("/smallImage".length);
  if (path === "/oss" || path.startsWith("/oss/")) path = path.slice("/oss".length);
  const relative = path.replace(/^\/+/, "");
  if (!relative || relative.endsWith("/") || relative.includes("//") || relative.split("/").some((part) => part === "." || part === "..")) {
    throw new MediaOwnershipError("INVALID_INPUT", "图片路径无效");
  }
  return `/${relative}`;
}

export function mediaPathAliases(value: unknown): string[] {
  const canonical = canonicalMediaPath(value);
  return [canonical, canonical.slice(1)];
}

async function hasTable(db: Knex | Knex.Transaction, table: string): Promise<boolean> {
  return db.schema.hasTable(table);
}

/** Resolve image media by relational ownership. A project-shaped path is never ownership evidence. */
export async function resolveImageMediaOwnership(db: Knex | Knex.Transaction, value: unknown): Promise<MediaOwnership> {
  const filePath = canonicalMediaPath(value);
  const aliases = [filePath, filePath.slice(1)];
  const rows: Array<{ projectId: unknown; filePath: unknown; source: string; image: boolean }> = [];
  const [hasUploads, hasBindings] = await Promise.all([
    hasTable(db, "ext_media_files"),
    hasTable(db, "ext_image_job_bindings"),
  ]);

  if (hasUploads) {
    rows.push(...await db("ext_media_files").whereIn("filePath", aliases)
      .select("projectId", "filePath", "kind").then((items: any[]) => items.map((item) => ({ ...item, source: "ext_media_files", image: item.kind === "image" }))));
  }
  if (hasBindings) {
    rows.push(...await db("ext_image_job_bindings").whereIn("artifactPath", aliases)
      .select("projectId", "artifactPath as filePath").then((items: any[]) => items.map((item) => ({ ...item, source: "ext_image_job_bindings", image: true }))));
  }
  rows.push(...await db("o_storyboard").whereIn("filePath", aliases)
    .select("projectId", "filePath").then((items: any[]) => items.map((item) => ({ ...item, source: "o_storyboard", image: true }))));
  rows.push(...await db("o_image as image").join("o_assets as asset", "asset.id", "=", "image.assetsId")
    .whereIn("image.filePath", aliases).select("asset.projectId", "image.filePath")
    .then((items: any[]) => items.map((item) => ({ ...item, source: "o_image", image: true }))));
  rows.push(...await db("o_video").whereIn("filePath", aliases)
    .select("projectId", "filePath").then((items: any[]) => items.map((item) => ({ ...item, source: "o_video", image: false }))));

  const normalized = rows.filter((row) => Number.isSafeInteger(Number(row.projectId)) && Number(row.projectId) > 0 && typeof row.filePath === "string");
  if (!normalized.length) throw new MediaOwnershipError("NOT_FOUND", "图片未关联可验证的项目");
  const projectIds = [...new Set(normalized.map((row) => Number(row.projectId)))];
  if (projectIds.length !== 1) throw new MediaOwnershipError("AMBIGUOUS_OWNER", "图片路径关联了多个项目");
  const imageRows = normalized.filter((row) => row.image);
  if (!imageRows.length) throw new MediaOwnershipError("NOT_FOUND", "路径没有图片归属记录");
  return { filePath, projectId: projectIds[0], sources: [...new Set(imageRows.map((row) => row.source))] };
}

export async function assertImageMediaProject(db: Knex | Knex.Transaction, projectId: number, value: unknown): Promise<string> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new MediaOwnershipError("INVALID_INPUT", "projectId 无效");
  const ownership = await resolveImageMediaOwnership(db, value);
  if (ownership.projectId !== projectId) throw new MediaOwnershipError("PROJECT_MISMATCH", "图片不属于当前项目");
  return ownership.filePath;
}
