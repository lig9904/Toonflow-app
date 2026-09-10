export function sortTracksByStoryboardIndex<T extends { id?: number | string | null }>(
  tracks: readonly T[],
  storyboards: readonly { trackId?: number | string | null; index?: number | string | null }[],
): T[] {
  const firstIndex = new Map<number, number>();
  for (const storyboard of storyboards) {
    const trackId = Number(storyboard.trackId);
    const index = Number(storyboard.index);
    if (!Number.isSafeInteger(trackId) || trackId <= 0 || !Number.isFinite(index)) continue;
    const previous = firstIndex.get(trackId);
    if (previous === undefined || index < previous) firstIndex.set(trackId, index);
  }
  return [...tracks].sort((left, right) => {
    const leftIndex = firstIndex.get(Number(left.id)) ?? Number.POSITIVE_INFINITY;
    const rightIndex = firstIndex.get(Number(right.id)) ?? Number.POSITIVE_INFINITY;
    return leftIndex - rightIndex || Number(left.id) - Number(right.id);
  });
}
