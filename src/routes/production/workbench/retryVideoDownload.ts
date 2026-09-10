import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { VideoJobError } from "@/services/videoJobs";
import { requireProductionOwner, sendProductionError } from "@/services/productionHttp";
import { getRuntimeVideoJobService } from "@/services/videoJobs/runtime";

const schema = z.object({
  projectId: z.number().int().positive(), scriptId: z.number().int().positive(), trackId: z.number().int().positive(), jobId: z.number().int().positive(),
}).strict();

export default express.Router().post("/", async (req, res) => {
  try {
    const input = schema.parse(req.body);
    await requireProductionOwner(req, input.projectId, u.db);
    const job = await getRuntimeVideoJobService().retryDownload(input);
    res.send(success({ jobId: job.id, videoId: job.videoId, status: job.status, reused: true }));
  } catch (error) {
    if (error instanceof VideoJobError) { sendProductionError(res, error); return; }
    sendProductionError(res, error);
  }
});
