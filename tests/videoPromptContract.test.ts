import test from "node:test";
import assert from "node:assert/strict";
import { isSeedance2Model } from "../src/lib/videoPromptReferences";
import { assertVideoPromptDialogue, speakerFindings, videoPromptSystem } from "../src/lib/videoPromptContract";

test("dated Seedance 2.0 and 2.5 IDs use the same supported family format", () => {
  for (const name of ["doubao-seedance-2-0-260128", "doubao-seedance-2-5-260628", "seedance-2.5-standard-i2v", "Seedance 2.0 Fast"]) assert.equal(isSeedance2Model(name), true, name);
  assert.equal(isSeedance2Model("seedance-20"), false);
});

test("swapping two explicit speakers is detected even when both names and lines remain nearby", () => {
  const source = "甲：第一句。\n乙：第二句。";
  const swapped = "乙：第一句。\n甲：第二句。";
  const findings = speakerFindings(source, swapped, ["甲", "乙"]);
  assert.equal(findings.filter((finding) => finding.code === "SPEAKER_CHANGED").length, 2);
  assert.equal(speakerFindings(source, source, ["甲", "乙"]).length, 0);
});
test("source dialogue cannot turn into no-dialogue output", () => {
  const source = "灵兽抱臂，对白：『我已知道。它……今天安静。』，雪璃压住笑声。";
  assert.throws(() => assertVideoPromptDialogue(source, "一名角色近景，无台词。"), /遗漏或改写/);
  assert.doesNotThrow(() => assertVideoPromptDialogue(source, "灵兽说{我已知道，它今天安静}，画外轻笑。"));
  assert.doesNotThrow(() => assertVideoPromptDialogue("牌子写着『欢迎』，无对白。", "码头静态全景。"));
  assert.match(videoPromptSystem("旧模板"), /语义身份描述不表示额外上传/);
});

test("unquoted Chinese dialogue remains protected and quoted signs are not speech", () => {
  for (const source of ["灵兽说：我已知道，它今天安静。", "画外音（雪璃）：别动，我会回来。", "台词：不要走！等着我！"]) {
    assert.throws(() => assertVideoPromptDialogue(source, "平静空镜"), /遗漏或改写/);
    assert.doesNotThrow(() => assertVideoPromptDialogue(source, source));
  }
  assert.throws(() => assertVideoPromptDialogue("雪璃：等着我。", "平静空镜", ["雪璃"]), /遗漏或改写/);
  assert.doesNotThrow(() => assertVideoPromptDialogue("画面：店铺牌子写着『欢迎』。", "空镜"));
});
