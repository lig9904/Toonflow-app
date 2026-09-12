import { preflightVideoPrompt } from "../videoPromptReview";
import u from "@/utils";
import { getPersistentVideoTaskProvider } from "@/utils/ai";
import { VideoJobService } from "./index";
import { fetchVideoBytes } from "./download";
import { finalizeAgentsYunVideo, sourceName } from "./compatibility";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import isPathInside from "is-path-inside";
import { revalidateTrustedVideoReferences } from "../volcengineReferenceRuntime";
import { claimVideoModeSelectionForSubmission, type VideoModeSelectionSnapshot } from "../videoModeResolution";

let singleton: VideoJobService | undefined;

export function getRuntimeVideoJobService(): VideoJobService {
  if (!singleton) {
    singleton = new VideoJobService(u.db, {
      providerFor: (modelKey) => getPersistentVideoTaskProvider(modelKey as `${string}:${string}`),
      beforeSubmit: async (job, config) => {
        const snapshot = config && typeof config === "object" ? (config as { toonflowModeSelection?: VideoModeSelectionSnapshot }).toonflowModeSelection : undefined;
        await revalidateTrustedVideoReferences(u.db, job.modelKey, config, (filePath) => u.oss.getImageBase64(filePath));
        const settings=config as any;
        if(settings?.toonflowPreflightAcknowledgement && snapshot){
          try { await preflightVideoPrompt(u.db,{projectId:job.projectId,scriptId:job.scriptId,trackId:job.trackId,prompt:settings.prompt,model:job.modelKey,mode:snapshot.resolvedMode,generation:{duration:settings.duration,resolution:settings.resolution,audio:settings.audio??false},info:snapshot.references,referenceBinding:snapshot,acknowledgement:settings.toonflowPreflightAcknowledgement}); }
          catch(error){throw Object.assign(error as Error,{submissionOutcome:"not_submitted"});}
        }
        if (snapshot) await claimVideoModeSelectionForSubmission(u.db, { jobId: job.id, projectId: job.projectId, scriptId: job.scriptId, trackId: job.trackId, snapshot }, (filePath) => u.oss.getImageBase64(filePath));
      },
      download: async (url, outputPath, job) => {
        const bytes = await fetchVideoBytes(url);
        if (!job?.modelKey.startsWith("agentsYun:")) {
          await u.oss.writeFile(outputPath, bytes);
          return;
        }
        const root = u.getPath("oss");
        const safe = path.resolve(root, String(outputPath).replace(/^[/\\]+/, ""));
        if (!isPathInside(safe, root)) throw new Error("视频输出路径不在 OSS 根目录内");
        const source = path.join(path.dirname(safe), sourceName(safe).split(path.sep).pop()!);
        await mkdir(path.dirname(source), { recursive: true });
        const sourceTemp = path.join(path.dirname(source), `.${path.basename(source)}.${randomUUID()}.tmp`);
        await writeFile(sourceTemp, bytes);
        try {
          await rename(sourceTemp, source);
          await finalizeAgentsYunVideo(source, safe);
        } catch (error) {
          // Keep the source for manual retry; VideoJobService records a local
          // download/transcode failure and never re-submits the provider job.
          throw error;
        } finally {
          await rm(sourceTemp, { force: true }).catch(() => undefined);
        }
      },
      maxConcurrent: 2,
    });
  }
  return singleton;
}

export async function resumeVideoJobs(): Promise<void> {
  await getRuntimeVideoJobService().resumeDueJobs();
}
