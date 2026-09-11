import assert from "node:assert/strict";
import test from "node:test";
import { explicitProductionTextScope, isExplicitVideoOnlyRequest, explicitVideoSettings } from "../src/services/builtinAgent/productionPrompts";

test("direct current-track and only-video commands have deterministic video-only intent", () => {
  for (const input of [
    "为当前轨道生成1条4秒视频，480p，无音频。沿用人工提示词，不出图、不重写分镜。",
    "请为选中的视频轨道制作一条4秒视频",
    "只生成视频",
    "仅制作1条6秒视频，不生成图片",
  ]) {
    assert.equal(isExplicitVideoOnlyRequest(input), true, input);
    assert.deepEqual(explicitProductionTextScope(input), ["generateVideos"]);
  }
});

test("negative, analytical, prompt-description and multi-stage requests do not force video generation", () => {
  for (const input of [
    "不要为当前轨道生成视频",
    "只生成视频，但是现在不要执行",
    "为当前轨道生成视频，先别生成视频",
    "分析视频内容",
    "只生成视频分镜",
    "只生成视频 的 提示词",
    "为当前轨道生成视频大纲",
    "检查当前视频",
    "只生成视频提示词",
    "为当前轨道生成视频描述",
    "先提取素材后生成视频",
    "为当前轨道生成视频，然后生成图片",
    "为当前轨道生成视频并审核制作内容",
    "故事里提到生成视频",
  ]) {
    assert.equal(isExplicitVideoOnlyRequest(input), false, input);
    assert.equal(explicitProductionTextScope(input), undefined);
  }
});

test("deterministic video requests retain explicit resolution and audio settings", () => {
  assert.deepEqual(explicitVideoSettings("为当前轨道生成1条4秒视频，1080p，无音频"), { resolution: "1080p", audio: false });
  assert.deepEqual(explicitVideoSettings("只生成视频，720P，带声音"), { resolution: "720p", audio: true });
  assert.deepEqual(explicitVideoSettings("只生成视频，无对白"), { resolution: null, audio: null });
  assert.throws(() => explicitVideoSettings("只生成视频，480p或720p"), /明确一个分辨率/);
});
