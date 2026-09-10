import test from "node:test";
import assert from "node:assert/strict";
import { sortTracksByStoryboardIndex } from "../src/services/trackOrdering";

test("tracks follow the earliest source storyboard index, then stable id order", () => {
  const tracks = [{ id: 30 }, { id: 100 }, { id: 20 }, { id: 200 }];
  const storyboards = [
    { trackId: 30, index: 0 },
    { trackId: 100, index: 2 },
    { trackId: 20, index: 1 },
    { trackId: 100, index: 3 },
  ];
  assert.deepEqual(sortTracksByStoryboardIndex(tracks, storyboards).map((track) => track.id), [30, 20, 100, 200]);
});

test("multiple storyboards use the minimum index and unassociated tracks stay last", () => {
  const tracks = [{ id: 9 }, { id: 8 }, { id: 7 }];
  const storyboards = [{ trackId: 9, index: 5 }, { trackId: 8, index: 2 }, { trackId: 9, index: 1 }];
  assert.deepEqual(sortTracksByStoryboardIndex(tracks, storyboards).map((track) => track.id), [9, 8, 7]);
});
