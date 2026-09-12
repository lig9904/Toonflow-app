import type { VideoPromptReviewReport } from "@/lib/videoPromptContract";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { resolveVideoReferenceMediaType } from "@/lib/videoPromptReferences";
import { getCreativeState } from "@/services/creativeWorkspace";
import { loadVideoReferenceInventory } from "@/services/videoPromptComposition";
import { sortTracksByStoryboardIndex } from "@/services/trackOrdering";
import { getConfiguredMediaModel } from "@/utils/ai";
import { ensureVideoModeIntentSchema, readVideoModeIntent, resolveStoredVideoMode, VideoModeResolutionError } from "@/services/videoModeResolution";
import { archivedTrackIds, listArchivedSharedTracks } from "@/services/storyboardTrackIndependence";
const router = express.Router();

interface VideoItem {
  id: number;
  jobId?: number;
  downloadRetryable?: boolean;
  src: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败" | "需人工核对";
}

interface TrackMedia {
  src: string;
  id?: number;
  fileType: "image" | "video" | "audio";
  videoDesc?: string;
}

interface TrackItem {
  id?: number;
  version: number;
  prompt: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  reason?: string;
  promptReview?: VideoPromptReviewReport | null;
  duration?: number;
  selectVideoId?: number;
  medias: TrackMedia[];
  videoList: VideoItem[];
  modeIntent: unknown;
  modeIntentRevision: number;
  promptReferenceRevision: number;
  references: unknown[];
  referencesInitialized: boolean;
  modeResolution: unknown;
  storyboardIds: number[];
  storyboardCount: number;
  cardKind: "storyboard" | "custom";
  deleteAction: "deleteStoryboard" | "deleteTrack";
  migrationRequired: boolean;
  mutationBlockedReason: string | null;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
  }),
  async (req, res) => {
    const { projectId, scriptId } = req.body;
    const projectData = await u.db("o_project").where("id", projectId).select("id", "videoModel", "mode").first();

    if (!projectData?.videoModel) {
      return res.status(400).json(success("项目未配置视频模型"));
    }
    let videoMode = "";
    try {
      videoMode = JSON.parse(projectData?.mode ?? "");
    } catch (e) {
      videoMode = projectData?.mode ?? "";
    }
    await ensureVideoModeIntentSchema(u.db);
    const capabilities = await getConfiguredMediaModel(projectData.videoModel, "video");

    const storyboardList = await u.db("o_storyboard").where({ scriptId, projectId }).orderBy("index", "asc");
    const storyboardStates = await u.db.schema.hasTable("ext_entity_state") ? await u.db("ext_entity_state").where({ projectId, entityType: "storyboard" }).whereIn("entityId", storyboardList.map((item) => Number(item.id))).select("entityId", "version") : [];
    await Promise.all(
      storyboardList.map(async (i) => {
        i.filePath = i.filePath ? await u.oss.getSmallImageUrl(i.filePath) : "";
      }),
    );
    const storyboardTrackRecord: Record<number, any[]> = {};
    storyboardList.forEach((i) => {
      if (storyboardTrackRecord[i.trackId!]) {
        storyboardTrackRecord[i.trackId!].push({
          src: i.filePath,
          fileType: "image",
          sources: "storyboard",
          ...(i.prompt != null ? { prompt: i.videoDesc } : {}),
          ...(i.id != null ? { id: i.id } : {}),
          index: i.index,
        });
      } else {
        storyboardTrackRecord[i.trackId!] = [
          {
            src: i.filePath,
            fileType: "image",
            sources: "storyboard",
            ...(i.prompt != null ? { prompt: i.videoDesc } : {}),
            ...(i.id != null ? { id: i.id } : {}),
            index: i.index,
          },
        ];
      }
    });
    for (const medias of Object.values(storyboardTrackRecord)) medias.forEach((item, index) => { item.purpose = medias.length === 1 && index === 0 ? "first_frame" : "style_reference"; });
    // 按 storyboardId 分组的资产数据，key 为 storyboardId
    const otherDataMap: Record<number, any[]> = {};
    // 解析 videoMode 中 audioReference 的数量，例如 'audioReference:3' => 3
    const audioReferenceCount = Number.MAX_SAFE_INTEGER;
    {
      const storyIds = storyboardList.map((s) => s.id);

      const inventory = await loadVideoReferenceInventory(u.db, { projectId, scriptId });
      const assetDatas = inventory.linkedAssets.filter((item) => storyIds.includes(Number(item.storyboardId)));
      const assets2AudioData = inventory.boundAudio;
      const audioRecord: Record<string, any> = {};
      await Promise.all(
        assets2AudioData.map(async (i) => {
          if (!audioRecord[i.roleAssetId]) audioRecord[i.roleAssetId] = [];
          audioRecord[i.roleAssetId].push({
            id: i.id,
            name: i.name,
            describe: i.describe,
            type: "audio",
            fileType: "audio" as const,
            sources: "assets",
            prompt: i.prompt,
            purpose: "audio_reference",
            src: await u.oss.getFileUrl(i.filePath),
          });
        }),
      );

      await Promise.all(
        assetDatas.map(async (i) => {
          const item = {
            id: i.id,
            name: i.name,
            describe: i.describe,
            type: i.type,
            fileType: resolveVideoReferenceMediaType(i.storedFileType, i.type, i.filePath),
            sources: "assets",
            purpose: resolveVideoReferenceMediaType(i.storedFileType, i.type, i.filePath) === "video" ? "motion_reference" : i.type === "role" ? "identity_reference" : "style_reference",
            src: i.filePath ? await u.oss.getSmallImageUrl(i.filePath) : "",
          };
          const sid = i.storyboardId as number;
          if (!otherDataMap[sid]) otherDataMap[sid] = [];
          otherDataMap[sid].push(item);
          if (audioRecord[i.id]) otherDataMap[sid].push(...audioRecord[i.id]);
          if (audioRecord[i.assetsId]) otherDataMap[sid].push(...audioRecord[i.assetsId]);
        }),
      );
    }

    const trackData = sortTracksByStoryboardIndex(
      await (async () => { const query = u.db("o_videoTrack").where({ projectId, scriptId }); const archived = await archivedTrackIds(u.db, projectId, scriptId); if (archived.length) query.whereNotIn("id", archived); return query; })(),
      storyboardList,
    );
    const videoList = await u.db("o_video").whereIn(
      "videoTrackId",
      trackData.map((t) => t.id),
    );
    const videoJobs = videoList.length ? await u.db("ext_video_jobs").whereIn("videoId", videoList.map((video) => String(video.id))).select("id", "videoId", "status", "upstreamTaskId", "resultUrl") : [];
    const jobByVideo = new Map(videoJobs.map((job) => [Number(job.videoId), job]));
    const trackList: TrackItem[] = [];
    const trackIdMap = [...new Set<number>(trackData.map((t) => t.id!))];
    for (const trackId of trackIdMap) {
      const item = trackData.find((t) => t.id === trackId);
      const trackStoryboardIds = storyboardList.filter((storyboard) => Number(storyboard.trackId) === Number(trackId)).map((storyboard) => Number(storyboard.id));
      const migrationRequired = trackStoryboardIds.length > 1;
      const modeSelection = await readVideoModeIntent(u.db, { projectId, scriptId, trackId });
      const currentMedias = (() => {
        const storyboardMedias = storyboardTrackRecord[trackId] ?? [];
        const assetMedias = storyboardMedias.flatMap((s) => otherDataMap[s.id] ?? []);
        const uniqueAssets = [...new Map(assetMedias.map((asset) => [`${asset.sources}:${asset.id}`, asset])).values()];
        return [...uniqueAssets.filter((asset) => asset.src), ...storyboardMedias, ...uniqueAssets.filter((asset) => !asset.src)];
      })();
      const defaultReferences = currentMedias.filter((media) => media.src && Number.isSafeInteger(Number(media.id))).map(({ id, sources, fileType, purpose }) => ({ id: Number(id), sources, fileType, purpose }));
      let modeResolution: any;
      try { modeResolution = await resolveStoredVideoMode(u.db, { projectId, scriptId, trackId, model: projectData.videoModel, capabilities, references: modeSelection.referencesInitialized ? modeSelection.references : defaultReferences, expectedIntentRevision: modeSelection.revision }); }
      catch (error) { modeResolution = { trackId, modeIntent: modeSelection.modeIntent, modeIntentRevision: modeSelection.revision, resolvedMode: null, resolvedReferences: modeSelection.referencesInitialized ? modeSelection.references : defaultReferences, referenceSummary: null, compatibility: { ok: false, code: error instanceof VideoModeResolutionError ? error.code : "VIDEO_MODE_INCOMPATIBLE", message: error instanceof Error ? error.message : "视频生成方式无法匹配" } }; }
      trackList.push({
        id: trackId,
        version: (await getCreativeState(u.db, "track", trackId, projectId)).version,
        duration: item?.duration ?? 0,
        prompt: item?.prompt || "",
        // The browser supplies the actual current model/mode/parameters/refs to checkVideoPrompt.
        // Returning a prompt-only match here could revive a stale report.
        promptReview: null,
        state: (item?.state as "未生成" | "生成中" | "已完成" | "生成失败") ?? "未生成",
        reason: item?.reason ?? "",
        selectVideoId: Number(item?.videoId)!,
        medias: currentMedias,
        modeIntent: modeSelection.modeIntent,
        modeIntentRevision: modeSelection.revision,
        promptReferenceRevision: modeSelection.promptReferenceRevision,
        references: modeSelection.referencesInitialized ? modeSelection.references : defaultReferences,
        referencesInitialized: modeSelection.referencesInitialized,
        modeResolution,
        storyboardIds: trackStoryboardIds,
        storyboardCount: trackStoryboardIds.length,
        cardKind: trackStoryboardIds.length === 1 ? "storyboard" : "custom",
        deleteAction: trackStoryboardIds.length === 1 ? "deleteStoryboard" : "deleteTrack",
        migrationRequired,
        mutationBlockedReason: migrationRequired ? "该历史片段仍包含多条分镜，请先完成一镜一片段迁移" : null,
        videoList: await Promise.all(
          videoList
            .filter((v) => v.videoTrackId === trackId)
          .map(async (v) => ({
              id: v.id!,
              ...(jobByVideo.get(Number(v.id)) ? { jobId: Number(jobByVideo.get(Number(v.id)).id), downloadRetryable: Boolean(jobByVideo.get(Number(v.id)).upstreamTaskId && jobByVideo.get(Number(v.id)).resultUrl && ["DOWNLOADING", "RECONCILIATION_REQUIRED"].includes(String(jobByVideo.get(Number(v.id)).status))) } : {}),
              src: v.filePath ? await u.oss.getFileUrl(v.filePath) : "",
              state: v.state === "已完成" || v.state === "生成成功" ? "已完成" : v.state === "生成中" ? "生成中" : v.state === "需人工核对" ? "需人工核对" : v.state === "生成失败" ? "生成失败" : "未生成",
              errorReason: v?.errorReason ?? "",
            })),
        ),
      });
    }
    const archivedSharedTracks = await Promise.all((await listArchivedSharedTracks(u.db, projectId, scriptId)).map(async (archive) => ({ ...archive, videos: await Promise.all(archive.videos.map(async (video: any) => ({ id: video.id, state: video.state, errorReason: video.errorReason, src: video.filePath ? await u.oss.getFileUrl(video.filePath) : "" }))) })));
    res.status(200).send(
      success({
        storyboardList: await Promise.all(
          storyboardList.map(async (s) => ({
            ...s,
            version: Number(storyboardStates.find((state) => Number(state.entityId) === Number(s.id))?.version ?? 0),
            src: s.filePath,
          })),
        ),
        trackList,
        archivedSharedTracks,
      }),
    );
  },
);
