export function matchVideoGenerationDuration(model: { durationResolutionMap?: Array<{ duration: number[]; resolution: string[] }> }, sourceDuration: number, resolution: string): number {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error("源分镜时长无效");
  const allowed = [...new Set((model.durationResolutionMap ?? []).filter((entry) => entry.resolution.includes(resolution)).flatMap((entry) => entry.duration))]
    .filter((duration) => Number.isFinite(duration) && duration >= sourceDuration).sort((a, b) => a - b);
  if (!allowed.length) throw new Error(`脚本 ${sourceDuration} 秒超出当前模型在 ${resolution} 下支持的时长，请拆分片段或更换模型`);
  return allowed[0];
}

export function videoTailHoldInstruction(sourceDuration: number, generatedDuration: number): string {
  if (generatedDuration <= sourceDuration) return "";
  return `源分镜计划 ${sourceDuration} 秒。全部原定对白和关键动作按源时间线在前 ${sourceDuration} 秒内完成；模型额外生成的尾部 ${Number((generatedDuration - sourceDuration).toFixed(3))} 秒只作自然静持，不添加新对白或新情节，供按脚本时长剪辑。不要通过加速画面改变原定动作节奏。`;
}
