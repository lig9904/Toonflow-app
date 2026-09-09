import fs from "node:fs/promises";
import path from "node:path";

export const MEDIA_ROOT_MARKER = ".toonflow-media-root";

/** External media mounts must already exist; never create a local replacement for an absent NAS. */
export async function ensureMediaDirectory(root: string, external: boolean): Promise<void> {
  if (!external) { await fs.mkdir(root, { recursive: true }); return; }
  try {
    if (!(await fs.stat(root)).isDirectory()) throw new Error("Not a directory");
    await fs.access(root, fs.constants.R_OK | fs.constants.W_OK);
    if (!(await fs.stat(path.join(root, MEDIA_ROOT_MARKER))).isFile()) throw new Error("Missing mount marker");
  } catch {
    throw new Error("外部媒体存储未就绪：请检查 NAS 挂载及 .toonflow-media-root 标记文件");
  }
}
