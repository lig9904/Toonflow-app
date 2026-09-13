import test from "node:test";
import assert from "node:assert/strict";
import { isSeedance2Model } from "../src/lib/videoPromptReferences";
import { assertVideoPromptDialogue, dialogueFindings, extractVideoDialogue, speakerFindings, videoPromptSystem } from "../src/lib/videoPromptContract";

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

test("known character names inside visual colon descriptions are not dialogue", () => {
  const source = "镜头1（2秒）：画内唯一主体是成年海獭九九：真实海獭物种体型与比例，棕色厚毛，圆耳，浅色口鼻，短小前爪，无衣着、无人类配饰，自然蹲伏于石台旁，不拟人化站立。无对白、无字幕。";
  assert.deepEqual(extractVideoDialogue(source, ["九九"]), []);
  assert.deepEqual(dialogueFindings(source, "成年海獭九九保持真实海獭比例、棕色厚毛、圆耳、浅色口鼻、短小前爪、无衣着，自然蹲伏。", ["九九"]), []);
  assert.deepEqual(extractVideoDialogue("小说：蓝贝壳。画面：海獭捧贝壳。"), []);
});

test("explicit fields, speech verbs, quoted names and line-boundary character dialogue remain protected", () => {
  const cases = [
    ["对白：不要走！", [], "不要走！"],
    ["画外音（雪璃）：别动，我会回来。", ["雪璃"], "别动，我会回来。"],
    ["镜头中雪璃问：你看见了吗？", ["雪璃"], "你看见了吗？"],
    ["雪璃：「等着我。」", ["雪璃"], "等着我。"],
    ["镜头1：雪璃：等着我。", ["雪璃"], "等着我。"],
  ] as const;
  for (const [source, names, speech] of cases) {
    assert.deepEqual(extractVideoDialogue(source, [...names]), [speech]);
    assert.throws(() => assertVideoPromptDialogue(source, "平静空镜", [...names]), /遗漏或改写/);
    assert.doesNotThrow(() => assertVideoPromptDialogue(source, `保留台词：${speech}`, [...names]));
  }
});

test('legacy inline stage directions stop after complete multi-sentence speech',()=>{
 const source='甲（同期口型）：不要慌。我会回来。说完下巴微扬。镜头继续推近。';
 assert.deepEqual(extractVideoDialogue(source,['甲']),['不要慌。我会回来。']);
 assert.doesNotThrow(()=>assertVideoPromptDialogue(source,'甲说：“不要慌。我会回来。”随后保持表情。',['甲']));
 assert.throws(()=>assertVideoPromptDialogue(source,'甲说：“不要慌。”',['甲']),/我会回来/);
});
test('quoted stage-like speech and quoted terms inside unquoted dialogue are not truncated',()=>{
 for(const source of ['导演：“镜头继续推近。不要切！”','导演：这叫“风暴”，不是玩笑。']){
  assert.throws(()=>assertVideoPromptDialogue(source,'空镜',['导演']),/遗漏或改写/);
 }
 assert.deepEqual(extractVideoDialogue('导演：“镜头继续推近。不要切！”',['导演']),['镜头继续推近。不要切！']);
 assert.deepEqual(extractVideoDialogue('导演：这叫“风暴”，不是玩笑。',['导演']),['这叫“风暴”，不是玩笑。']);
});
test('inline staging does not hide a swapped speaker or offscreen mismatch',()=>{
 const source='甲（画外音）：等着我。我很快回来。镜头停在门上。';
 assert.ok(speakerFindings(source,'乙：“等着我。我很快回来。”',['甲','乙']).some(f=>f.code==='SPEAKER_CHANGED'));
 assert.ok(speakerFindings(source,'甲：“等着我。我很快回来。”',['甲','乙']).some(f=>f.code==='OFFSCREEN_SPEECH_CHANGED'));
 assert.deepEqual(speakerFindings(source,'甲（画外音）：“等着我。我很快回来。”',['甲','乙']),[]);
});

test("paired quotes preserve nested terms and apostrophes",()=>{
 assert.deepEqual(extractVideoDialogue('甲：“这是‘风暴’，别怕。”镜头拉远。',['甲']),['这是‘风暴’，别怕。']);
 assert.deepEqual(extractVideoDialogue(`甲：“I'm ready. Don't go.”镜头拉远。`,['甲']),["I'm ready. Don't go."]);
});
