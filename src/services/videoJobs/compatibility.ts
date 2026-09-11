import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ffprobePath = process.env.TOONFLOW_FFPROBE_PATH || (process.platform === "darwin" ? "/opt/homebrew/bin/ffprobe" : "/usr/bin/ffprobe");
const ffmpegPath = process.env.TOONFLOW_FFMPEG_PATH || (process.platform === "darwin" ? "/opt/homebrew/bin/ffmpeg" : "/usr/bin/ffmpeg");
let active = 0;
const waiters: Array<() => void> = [];
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 100_000_000;

export interface VideoProbe {
  codec: string;
  audioCodec?: string;
  audioCodecs: string[];
  pixelFormat: string;
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  duration: number;
  hdr: boolean;
}

export class VideoCompatibilityError extends Error {
  constructor(message: string) { super(message); this.name = "VideoCompatibilityError"; }
}

async function limit<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
  try { return await work(); } finally { active -= 1; waiters.shift()?.(); }
}

export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const inputStat = await stat(filePath).catch(() => undefined);
  if (!inputStat?.isFile() || inputStat.size === 0) throw new VideoCompatibilityError("视频文件为空");
  if (inputStat.size > MAX_INPUT_BYTES) throw new VideoCompatibilityError("视频文件超过兼容处理大小限制");
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath], { timeout: 30_000, maxBuffer: 1_000_000 }));
  } catch (error) {
    throw new VideoCompatibilityError(`视频探测失败：${error instanceof Error ? error.message : String(error)}`);
  }
  let data: any;
  try { data = JSON.parse(stdout); } catch { throw new VideoCompatibilityError("视频探测结果无效"); }
  const stream = Array.isArray(data?.streams) ? data.streams.find((item: any) => item.codec_type === "video") : undefined;
  const width = Number(stream?.width), height = Number(stream?.height), duration = Number(stream?.duration ?? data?.format?.duration);
  if (!stream || !Number.isSafeInteger(width) || width <= 0 || width > MAX_DIMENSION || !Number.isSafeInteger(height) || height <= 0 || height > MAX_DIMENSION || width * height > MAX_PIXELS || !Number.isFinite(duration) || duration <= 0 || duration > 3_600) throw new VideoCompatibilityError("视频分辨率或时长无效");
  const codec = String(stream.codec_name ?? "").toLowerCase();
  const audioStream = Array.isArray(data?.streams) ? data.streams.find((item: any) => item.codec_type === "audio") : undefined;
  const audioCodecs = Array.isArray(data?.streams) ? data.streams.filter((item: any) => item.codec_type === "audio").map((item: any) => String(item.codec_name ?? "unknown").toLowerCase()) : [];
  const audioCodec = audioStream?.codec_name ? String(audioStream.codec_name).toLowerCase() : undefined;
  const pixelFormat = String(stream.pix_fmt ?? "").toLowerCase();
  const hdr = [stream.color_transfer, stream.color_primaries, stream.color_space].some((value: unknown) => ["smpte2084", "arib-std-b67", "bt2020", "bt2020nc"].includes(String(value).toLowerCase()));
  const rotationValue = Number(stream?.tags?.rotate ?? stream?.side_data_list?.find((item: any) => item.rotation != null)?.rotation ?? 0);
  const rotation = Number.isFinite(rotationValue) ? ((rotationValue % 360) + 360) % 360 : 0;
  const quarterTurn = rotation === 90 || rotation === 270;
  return { codec, audioCodec, audioCodecs, pixelFormat, width, height, displayWidth: quarterTurn ? height : width, displayHeight: quarterTurn ? width : height, rotation, duration, hdr };
}

function sourceName(outputPath: string): string {
  return outputPath.replace(/\.[^.\\/]+$/, ".source.mp4");
}

/** Downloaded Agent cloud video compatibility finalizer. It never contacts a provider. */
export async function finalizeAgentsYunVideo(sourcePath: string, outputPath: string): Promise<{ sourcePath: string; converted: boolean; probe: VideoProbe }> {
  return limit(async () => {
    await access(sourcePath, constants.R_OK);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.size === 0) throw new VideoCompatibilityError("原始视频为空");
    const probe = await probeVideo(sourcePath);
    if (probe.hdr) throw new VideoCompatibilityError("检测到 HDR 色彩元数据，当前兼容链路拒绝转换，已保留原片");
    const alreadyCompatible = probe.codec === "h264" && probe.pixelFormat === "yuv420p" && probe.audioCodecs.every((codec) => codec === "aac");
    if (alreadyCompatible) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await rename(sourcePath, outputPath);
      return { sourcePath, converted: false, probe };
    }
    const tempDir = await mkdtemp(path.join(path.dirname(outputPath), ".video-compat-"));
    const tempOutput = path.join(tempDir, "converted.mp4");
    try {
      const videoOptions = probe.codec === "h264" && probe.pixelFormat === "yuv420p"
        ? ["-c:v", "copy"] : ["-c:v", "libx264", "-threads:v", "2", "-pix_fmt", "yuv420p"];
      await execFileAsync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_threads", "2", "-filter_complex_threads", "2", "-i", sourcePath, "-map", "0:v:0", "-map", "0:a?", ...videoOptions, "-c:a", "aac", "-threads:a", "2", "-movflags", "+faststart", tempOutput], { timeout: 180_000, maxBuffer: 2_000_000 });
      const convertedStat = await stat(tempOutput);
      if (!convertedStat.isFile() || convertedStat.size === 0) throw new VideoCompatibilityError("兼容视频为空");
      const convertedProbe = await probeVideo(tempOutput);
      if (convertedProbe.codec !== "h264" || convertedProbe.pixelFormat !== "yuv420p" || convertedProbe.displayWidth !== probe.displayWidth || convertedProbe.displayHeight !== probe.displayHeight || convertedProbe.audioCodecs.some((codec) => codec !== "aac") || Math.abs(convertedProbe.duration - probe.duration) > 1.0) throw new VideoCompatibilityError("兼容视频探测结果不满足原片分辨率或时长");
      await mkdir(path.dirname(outputPath), { recursive: true });
      await rename(tempOutput, outputPath);
      return { sourcePath, converted: true, probe: convertedProbe };
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  });
}

export { sourceName };
