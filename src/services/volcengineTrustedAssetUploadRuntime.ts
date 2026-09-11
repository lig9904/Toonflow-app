import u from "@/utils";
import { requireProjectAccess, TeamSecurityError } from "./team";
import { referenceSourceHash } from "./volcengineReferenceRuntime";
import { createConfiguredVolcengineTrustedAssetClient } from "./volcengineTrustedAssets";
import { createVolcengineAssetUploadRuntime } from "./volcengineTrustedAssetUploads";
import { createVolcengineTrustedAssetUploadRecovery } from "./volcengineTrustedAssetUploadRecovery";

export function getTrustedAssetUploadRuntime() {
  return createVolcengineAssetUploadRuntime(u.db, {
    rootDir: u.getPath("oss"), publicOrigin: String(process.env.TOONFLOW_MEDIA_PUBLIC_ORIGIN || ""), secret: String(process.env.TOONFLOW_MEDIA_BRIDGE_SECRET || ""),
  }, referenceSourceHash((filePath) => u.oss.getImageBase64(filePath)));
}

let recovery: ReturnType<typeof createVolcengineTrustedAssetUploadRecovery> | undefined;
export function getTrustedAssetUploadRecovery() {
  return recovery ??= createVolcengineTrustedAssetUploadRecovery({
    db: u.db,
    client: () => createConfiguredVolcengineTrustedAssetClient(u.db),
    runtime: getTrustedAssetUploadRuntime,
    authorize: async ({ actorId, projectId }) => {
      const match = actorId.match(/^human:(\d+)$/);
      if (!match) return false;
      try { await requireProjectAccess(u.db, Number(match[1]), projectId, "edit"); return true; }
      catch (error) {
        if (error instanceof TeamSecurityError && [401, 403, 404].includes(error.status)) return false;
        throw error;
      }
    },
  });
}

export function kickTrustedAssetUpload(kind: "group" | "asset", operationId: string): void {
  void getTrustedAssetUploadRecovery().kick({ kind, operationId }).catch((error) => console.error("[trustedAssets] recovery kick failed", error instanceof Error ? error.name : "UnknownError"));
}
