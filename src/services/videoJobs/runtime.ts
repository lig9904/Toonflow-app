import u from "@/utils";
import { getPersistentVideoTaskProvider } from "@/utils/ai";
import { VideoJobService } from "./index";
import { fetchVideoBytes } from "./download";

let singleton: VideoJobService | undefined;

export function getRuntimeVideoJobService(): VideoJobService {
  if (!singleton) {
    singleton = new VideoJobService(u.db, {
      providerFor: (modelKey) => getPersistentVideoTaskProvider(modelKey as `${string}:${string}`),
      download: async (url, outputPath) => {
        await u.oss.writeFile(outputPath, await fetchVideoBytes(url));
      },
      maxConcurrent: 2,
    });
  }
  return singleton;
}

export async function resumeVideoJobs(): Promise<void> {
  await getRuntimeVideoJobService().resumeDueJobs();
}
