import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStoryboardImagePrompt, buildStoryboardVideoPrompt, reconcileStoryboardAssetIds, visualText, visualStyleHint } from "../src/lib/storyboardVisualContract";

const assets = [
  { id: 1, name: "灵兽", type: "role", describe: "非人类的螭吻神兽，红金羽鳞、蓝宝石、金爪" },
  { id: 2, name: "雪璃", type: "role", describe: "狐族年轻成年女性，银白长发、狐耳、红白金服饰" },
  { id: 5, name: "古港海岸", type: "scene", describe: "清晨海岸与白色灯塔" },
  { id: 7, name: "海螺", type: "tool", describe: "珍珠白螺旋海螺" },
  { id: 29, assetsId: 1, name: "记忆灵兽", type: "role", describe: "记忆中的灵兽" },
];
const s06 = "古港海岸，灵兽抱臂别过头，眼角偷偷瞥向海螺，半秒停顿后对白：『我已知道。它……今天安静。』，雪璃压住笑声。";

test("S06 binds the omitted adult character and removes spoken captions while retaining the shot", () => {
  const ids = reconcileStoryboardAssetIds({ prompt: s06, associateAssetsIds: [1, 7, 5] }, assets);
  assert.deepEqual(ids, [1, 7, 5, 2]);
  const prompt = buildStoryboardImagePrompt({ prompt: s06, videoDesc: "特写反应，嘴硬心虚。", assets: ids.map((id) => assets.find((asset) => asset.id === id)!), style: "国风二次元，赛璐璐平涂" });
  assert.match(prompt, /参考图4（@图4）=雪璃：狐族年轻成年女性/);
  assert.match(prompt, /特写反应/);
  assert.match(prompt, /不要改成全身站姿展示/);
  assert.match(prompt, /灵兽抱臂别过头/);
  assert.match(prompt, /雪璃压住笑声/);
  assert.doesNotMatch(prompt, /我已知道|今天安静/);
  assert.match(prompt, /不添加字幕/);
});

test("macro shots prioritize their detail over a full reference pose", () => {
  const prompt = buildStoryboardImagePrompt({ prompt: "海螺裂纹微距，金爪只入画一角。", assets: [assets[0], assets[3]] });
  assert.match(prompt, /极特写或微距，仅展示本镜头指定的局部细节/);
});

test("off-screen speech and explicitly excluded characters do not add visual references", () => {
  for (const prompt of ["灵兽特写。\n画外音（雪璃）：『走吧。』", "灵兽特写，雪璃（画外）轻笑。", "灵兽特写，不画雪璃。", "灵兽特写，雪璃在画外笑。"] ) {
    assert.deepEqual(reconcileStoryboardAssetIds({ prompt, associateAssetsIds: [1] }, assets), [1], prompt);
  }
});

test("selected variants cover the base name, while explicit two-version scenes keep both", () => {
  assert.deepEqual(reconcileStoryboardAssetIds({ prompt: "灵兽抱起海螺", associateAssetsIds: [29, 7] }, assets), [29, 7]);
  assert.deepEqual(reconcileStoryboardAssetIds({ prompt: "记忆灵兽抱起海螺", associateAssetsIds: [1, 7] }, assets), [7, 29]);
  assert.deepEqual(reconcileStoryboardAssetIds({ prompt: "记忆灵兽与灵兽同框对望", associateAssetsIds: [29] }, assets), [29, 1]);
});

test("ambiguous identities require an explicit selected ID; unknown IDs are rejected", () => {
  const duplicated = [...assets, { id: 20, name: "雪璃", type: "role" }];
  assert.throws(() => reconcileStoryboardAssetIds({ prompt: "雪璃笑", associateAssetsIds: [] }, duplicated), /多个素材/);
  assert.deepEqual(reconcileStoryboardAssetIds({ prompt: "雪璃笑", associateAssetsIds: [2] }, duplicated), [2]);
  assert.throws(() => reconcileStoryboardAssetIds({ prompt: "灵兽", associateAssetsIds: [999] }, assets), /范围外/);
});

test("visual text on a sign survives while video retains dialogue and camera instructions", () => {
  assert.equal(visualText("牌子写着：『欢迎回家』。"), "牌子写着：『欢迎回家』。");
  const video = buildStoryboardVideoPrompt([{ prompt: s06, videoDesc: "特写反应，嘴硬心虚。", duration: 3 }]);
  assert.match(video, /我已知道/); assert.match(video, /特写反应/); assert.match(video, /3秒/);
});

test("style tags come from the selected style guide rather than its directory name", () => {
  assert.equal(visualStyleHint("2D_chinese_guofeng", "| **Seedance 2.0（中文）** | `国风二次元动画，赛璐璐平涂` |"), "国风二次元动画，赛璐璐平涂");
});

test("unquoted speaker lines stay in video but do not condition the image", () => {
  const videoDesc = "特写反应，灵兽抱臂。灵兽（同期口型）：我已知道。它今天安静。雪璃轻笑（画外音，不入画）。";
  const prompt = buildStoryboardImagePrompt({ prompt: "灵兽抱臂别头，眼角看向海螺。", videoDesc, assets: [assets[0], assets[3]] });
  assert.match(prompt, /特写反应，灵兽抱臂/);
  assert.doesNotMatch(prompt, /我已知道|今天安静|雪璃轻笑/);
  assert.match(buildStoryboardVideoPrompt([{ prompt: "灵兽抱臂", videoDesc, duration: 3 }]), /我已知道。它今天安静/);
  assert.equal(visualText("路牌上的文字为：灵兽：回家。", ["灵兽"]), "路牌上的文字为：灵兽：回家。");
});
