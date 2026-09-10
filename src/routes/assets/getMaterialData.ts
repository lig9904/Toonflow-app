import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getCreativeState } from "@/services/creativeWorkspace";
const router = express.Router();

// 获取生成图片
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId } = req.body;
    const list = await u
      .db("o_assets")
      .leftJoin("o_image", "o_assets.id", "=", "o_image.assetsId")
      .where("o_assets.type", "clip")
      .andWhere("o_assets.projectId", projectId)
      .select("*");
    const data = await Promise.all(
      list.map(async (item) => ({
        ...item,
        filePath: item.filePath ? await u.oss.getFileUrl(item.filePath) : "",
      })),
    );
    //拿到本地片尾视频并插入到data中
    const ending = await u.oss.getFileUrl("/ending.mp4", "assets");
    data.push({
      id: 0,
      name: "Toonflow片尾",
      filePath: ending,
      type: "clip",
    });
    // 查询视频轨道
    const storyboards = scriptId
      ? await u.db("o_storyboard").where({ scriptId, projectId }).orderBy("index", "asc").select("id", "trackId", "duration", "index")
      : [];
    const storyboardByTrack = new Map<number, any[]>();
    for (const storyboard of storyboards) {
      const trackId = Number(storyboard.trackId);
      if (!Number.isSafeInteger(trackId) || trackId <= 0) continue;
      const list = storyboardByTrack.get(trackId) ?? [];
      list.push(storyboard);
      storyboardByTrack.set(trackId, list);
    }
    const creativeStateAvailable = await u.db.schema.hasTable("ext_creative_state");
    const trackRows = await u
      .db("o_videoTrack")
      .where("o_videoTrack.scriptId", scriptId)
      .andWhere("o_videoTrack.projectId", projectId)
      .select("o_videoTrack.id as trackId", "o_videoTrack.videoId", "o_videoTrack.duration as trackDuration");
    const trackOrder = new Map<number, number>();
    for (const [trackId, rows] of storyboardByTrack) trackOrder.set(trackId, Math.min(...rows.map((row) => {
      const index = Number(row.index);
      return Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER;
    })));
    trackRows.sort((a: any, b: any) => (trackOrder.get(Number(a.trackId)) ?? Number.MAX_SAFE_INTEGER) - (trackOrder.get(Number(b.trackId)) ?? Number.MAX_SAFE_INTEGER));
    // 按轨道分组处理视频
    const video = await Promise.all(
      trackRows.map(async (track) => {
        const videoItems = await u.db("o_video").where("o_video.videoTrackId", track.trackId).andWhere("o_video.state", "生成成功").select("*");
        const plannedDuration = (storyboardByTrack.get(Number(track.trackId)) ?? []).reduce((sum, row) => {
          const value = Number(row.duration);
          return Number.isFinite(value) && value >= 0 ? sum + value : sum;
        }, 0);
        const trackVersion = creativeStateAvailable ? (await getCreativeState(u.db, "track", Number(track.trackId), projectId)).version : 0;
        const videoList = await Promise.all(
          videoItems.map(async (v) => ({
            id: v.id,
            filePath: v.filePath ? await u.oss.getFileUrl(v.filePath) : "",
            videoTrackId: v.videoTrackId,
            videoId: v.id,
            sourceDuration: 0,
            plannedDuration,
            trackVersion,
            version: trackVersion,
            sourceRef: { projectId, scriptId, trackId: Number(track.trackId), videoId: Number(v.id), version: trackVersion },
          })),
        );
        return {
          id: track.trackId,
          videoId: track.videoId,
          trackId: Number(track.trackId),
          trackVersion,
          version: trackVersion,
          plannedDuration: plannedDuration > 0 ? plannedDuration : Number(track.trackDuration) || 0,
          storyboardIds: (storyboardByTrack.get(Number(track.trackId)) ?? []).map((row) => Number(row.id)),
          video: videoList,
        };
      }),
    ).then((tracks) => tracks.filter((track) => track.video.length > 0));

    res.status(200).send(success({ data, video }));
  },
);
