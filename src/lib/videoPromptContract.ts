/** Server-owned input/output protocol, shared by every model and mode. */
export function videoPromptSystem(reference?: string): string {
  return `${reference ?? ""}\n\n执行协议：输入为本片段全部源分镜、语义身份、实际参考映射及参数，不要求旧 XML。只返回最终视频提示词正文，不输出解释、示例或生成成功声明。
逐镜保留画面、动作、镜头、对白与说话人，区分画内和画外。参考不能替换当前剧情；语义身份描述不表示额外上传了图片。只使用提供的引用标签和顺序。
物种、年龄、性别、形态、服装只依据明确设定；非人类幼态不等于人类儿童，明确儿童如实保留。未绑定音色不编造年龄、性别或音色。
保留用户明确的光影、配乐、镜像、记忆同框和当前创作要求，不擅自增加角色或剧情。按源时间线安排动作与对白；额外生成时长可自然延续或静持，精确裁剪由后期处理，不承诺逐帧时序。音频关闭时保留对白作为剧情与表演依据，不声称生成有声对白。模式、时长、分辨率和参考上限以程序参数为准。`;
}

export interface VideoPromptFinding { code: string; severity: "error" | "warning" | "info"; message: string; shotId?: number; field?: string }
export interface VideoPromptReviewReport {
  status: "passed" | "issues" | "failed" | "pending" | "skipped";
  findings: VideoPromptFinding[];
  summary: string;
  revised: boolean;
  reviewedAt: number;
}
const normalize = (text: string) => text.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "").toLowerCase();
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Only speech-labelled text is deterministic dialogue evidence, never signs or camera prose. */
export function extractVideoDialogue(source: string, speakerNames: string[] = []): string[] {
  const names = speakerNames.filter(Boolean).map(escaped).sort((a, b) => b.length - a.length);
  const labels = ["对白", "台词", "画外音", "旁白", "内心独白", "内心OS", "VO", "OS", "说道", "喊道", "说", "问", "回答", ...names].join("|");
  const speech = new RegExp(`(?:${labels})(?:[（(][^）)\\n]{0,40}[）)])?[^。！？!?\\n『「“\":：]{0,30}[：:]\\s*([^\\n]+)`, "giu");
  const result: string[] = [];
  for (const match of source.matchAll(speech)) {
    const tail = match[1].trim();
    const quote = tail.match(/^[^『「“"]{0,20}[『「“"]([^』」”"\n]+)[』」”"]/u);
    const text = (quote?.[1] ?? tail.split(/\s*[|｜]\s*|[；;]\s*(?:画面|动作|镜头|音效|景别|时长)[：:]/u)[0]).trim();
    if (text && !/^(?:无|无台词|无对白|暂无|无旁白)[。.]?$/.test(text)) result.push(text);
  }
  return [...new Set(result)];
}
export function dialogueFindings(source: string, result: string, speakerNames: string[] = []): VideoPromptFinding[] {
  const generated = normalize(result);
  return extractVideoDialogue(source, speakerNames).filter((speech) => !generated.includes(normalize(speech)))
    .map((speech) => ({ code: "DIALOGUE_CHANGED", severity: "warning", field: "dialogue", message: `提示词遗漏或改写了源分镜台词：${speech}` }));
}
export function assertVideoPromptDialogue(source: string, result: string, speakerNames: string[] = []): void {
  const finding = dialogueFindings(source, result, speakerNames)[0];
  if (finding) throw new Error(finding.message);
}
export function referenceLabelFindings(prompt: string, labels: readonly string[]): VideoPromptFinding[] {
  const allowed = new Set(labels);
  return [...new Set(prompt.match(/@(?:图片|视频|音频|图|image|video|audio)\s*\d+/giu) ?? [])]
    .filter((label) => !allowed.has(label)).map((label) => ({ code: "INVALID_REFERENCE_LABEL", severity: "error", field: "references", message: `提示词引用了本次未提供的标签 ${label}；实际映射：${labels.join("、") || "无参考"}` }));
}

/** Check explicit named speech only; uncertain attribution stays a review warning. */
export function speakerFindings(source: string, result: string, speakerNames: string[] = []): VideoPromptFinding[] {
  const findings: VideoPromptFinding[] = [];
  const normalized = normalize(result);
  const check = (name: string, text: string, offscreen: boolean) => {
    const speech = normalize(text);
    const index = normalized.indexOf(speech);
    if (!speech || index < 0) return; // Missing speech is reported separately.
    const vicinity = normalized.slice(Math.max(0, index - 70), index + speech.length + 30);
    if (!vicinity.includes(normalize(name))) findings.push({ code: "SPEAKER_CHANGED", severity: "warning", field: "speaker", message: `对白缺少源说话人 ${name} 的对应标注` });
    if (offscreen && !/画外|旁白|vo|os/iu.test(vicinity)) findings.push({ code: "OFFSCREEN_SPEECH_CHANGED", severity: "warning", field: "speaker", message: `${name} 的画外对白缺少画外标记` });
  };
  const tags = /(?:画外音|旁白|对白|台词)[（(]([^）)\n]+)[）)]\s*[：:]\s*(?:[『「“"]([^』」”"\n]+)[』」”"]|([^\n]+))/gu;
  for (const match of source.matchAll(tags)) {
    const attributes = match[1].split(/[，,、]/u).map((item) => item.trim());
    const name = speakerNames.find((candidate) => attributes.includes(candidate)) ?? attributes.find((item) => !/^(?:画外|画内|画外音|旁白|VO|OS|男声|女声|低声|低沉|轻柔|苍老|平静)$/iu.test(item));
    if (name) check(name, match[2] ?? match[3] ?? "", /画外|旁白|VO|OS/iu.test(match[0].split(/[：:]/u)[0]));
  }
  for (const name of [...new Set(speakerNames)].filter(Boolean)) {
    const pattern = new RegExp(`${escaped(name)}(?:[（(]([^）)\\n]{0,30})[）)])?(?:说|说道|问|回答)?[：:]\\s*(?:[『「“\"]([^』」”\"\\n]+)[』」”\"]|([^\\n]+))`, "gu");
    for (const match of source.matchAll(pattern)) check(name, match[2] ?? match[3] ?? "", /画外|旁白|VO|OS/iu.test(match[1] ?? ""));
  }
  return findings;
}
