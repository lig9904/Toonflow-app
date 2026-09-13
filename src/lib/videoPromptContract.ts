import type { VideoPreflightTarget, VideoPreflightVerdict } from "./videoPreflightContract";
import type { VideoPromptReviewFailure } from "../services/videoPromptReviewRuntime";

/** Server-owned input/output protocol, shared by every model and mode. */
export function videoPromptSystem(reference?: string): string {
  return `${reference ?? ""}\n\n执行协议：输入为本片段全部源分镜、语义身份、实际参考映射及参数，不要求旧 XML。只返回最终视频提示词正文，不输出解释、示例或生成成功声明。
逐镜保留画面、动作、镜头、对白与说话人，区分画内和画外。参考不能替换当前剧情；语义身份描述不表示额外上传了图片。只使用提供的引用标签和顺序。
物种、年龄、性别、形态、服装只依据明确设定；非人类幼态不等于人类儿童，明确儿童如实保留。未绑定音色不编造年龄、性别或音色。
保留用户明确的光影、配乐、镜像、记忆同框和当前创作要求，不擅自增加角色或剧情。按源时间线安排动作与对白；额外生成时长可自然延续或静持，精确裁剪由后期处理，不承诺逐帧时序。音频关闭时保留对白作为剧情与表演依据，不声称生成有声对白。模式、时长、分辨率和参考上限以程序参数为准。`;
}

export interface VideoPromptFinding { code: string; severity: "error" | "warning" | "info"; message: string; shotId?: number; field?: string; target?: VideoPreflightTarget; overridable?: boolean; expected?: string; suggestion?: string }
export interface VideoPromptReviewReport {
  preflight?: VideoPreflightVerdict;
  status: "passed" | "issues" | "failed" | "pending" | "skipped";
  findings: VideoPromptFinding[];
  summary: string;
  revised: boolean;
  reviewedAt: number;
  failure?: VideoPromptReviewFailure;
}
const normalize = (text: string) => text.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "").toLowerCase();
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A quoted utterance is authoritative, including any punctuation or stage-like
 * words spoken by the character. For legacy unquoted lines, only split after
 * sentence boundaries followed by recognizable staging/camera instructions. */
export function dialogueText(tailValue: string, speakerNames: string[] = []): string {
  let tail = tailValue.trim();
  const names = speakerNames.filter(Boolean).map(escaped).sort((a,b)=>b.length-a.length);
  if (names.length) tail = tail.replace(new RegExp(`^(?:${names.join("|")})(?:[（(][^）)\\n]{0,40}[）)])?\\s*[：:]\\s*`,"u"), "");
  const pairs:Record<string,string>={"“":"”","「":"」","『":"』","‘":"’",'"':'"',"'":"'"};
  const closing=pairs[tail[0]];
  if(closing)for(let i=1;i<tail.length;i++) {
    if(tail[i]!==closing || tail[i-1]==="\\")continue;
    if(closing==="'" && /[A-Za-z]/.test(tail[i-1]??"") && /[A-Za-z]/.test(tail[i+1]??""))continue;
    return tail.slice(1,i).trim();
  }
  tail = tail.split(/\s*[|｜]\s*|[；;]\s*(?:画面|动作|镜头|音效|景别|时长|剪辑|转场)[：:]/u)[0].trim();
  const bodyAction = "(?:脚步|爪尖|前爪|金爪|双爪|手腕|双手|嘴角|下巴|尾巴|尾部|耳鳍|羽鳞|视线|眼神)";
  const staging = new RegExp(`^(?:(?:台词|对白)?说完(?:后|时|[，,]|${bodyAction}|以|[^。！？!?]{1,12}(?:轻摇|微扬|轻摆|微颤|抬起|落下|收回))|(?:镜头|画面)(?:继续|缓缓|极缓|慢慢|停|转|切|推|拉|跟|淡|收|保)|(?:硬切|叠化|淡入|淡出|动作匹配切|运镜)|(?:以[^。！？!?]{0,45}(?:动作匹配|转场|硬切|切下一镜))|(?:动作|剪辑|转场|音效|环境音|字幕|结束状态)[：:]|(?:约?\\d+(?:\\.\\d+)?秒)(?:淡入|淡出|切|收)|(?:最后(?:\\d+(?:\\.\\d+)?秒|一个[^。！？!?]{1,15}(?:缓缓|慢慢|轻轻|逐渐|迅速)))|(?:背景里|背景中|伴随[^。！？!?]{0,25}(?:音效|低音|风声|水声))|(?:(?:${names.length ? names.join("|") : "(?!)"})?${bodyAction})(?:微|轻|缓|慢|顿|点|抬|落|收|摆|停|转|仍|保)|(?:[^。！？!?]{1,12}涟漪)(?:扩散|荡开|消散))`, "u");
  for (const boundary of tail.matchAll(/[。！？!?；;]\s*/gu)) {
    const end = boundary.index! + boundary[0].length;
    if (staging.test(tail.slice(end))) return tail.slice(0,end).trim();
  }
  return tail;
}

/** Only speech-labelled text is deterministic dialogue evidence, never signs or camera prose. */
export function extractVideoDialogue(source: string, speakerNames: string[] = []): string[] {
  const names = speakerNames.filter(Boolean).map(escaped).sort((a, b) => b.length - a.length);
  const result: string[] = [];
  const append = (tailValue: string) => {
    const text = dialogueText(tailValue, speakerNames);
    if (text && !/^(?:无|无台词|无对白|暂无|无旁白)[。.]?$/.test(text)) result.push(text);
  };
  // Explicit speech fields are semantic evidence even without a named speaker.
  const explicit = /(?:^|[。！？!?；;，,：:\n])\s*(?:对白|台词|画外音|旁白|内心独白|内心OS|VO|OS)(?:[（(][^）)\n]{0,40}[）)])?\s*[：:]\s*([^\n]+)/gimu;
  for (const match of source.matchAll(explicit)) append(match[1]);
  // A speech verb is meaningful when attached to a known speaker (or a
  // multi-character speaker token when no inventory was supplied). Requiring
  // the subject prevents words such as "小说：" from becoming dialogue.
  const spokenSubject = names.length ? names.join("|") : "[\\p{L}\\p{N}_]{2,20}";
  const spoken = new RegExp(`(?:${spokenSubject})(?:在画外)?(?:说道|喊道|回答|说|问)\\s*[：:]\\s*([^\\n]+)`, "giu");
  for (const match of source.matchAll(spoken)) append(match[1]);
  // Bare "角色：台词" remains supported at a line/sentence/field boundary.
  // Do not scan arbitrary prose for a known name followed by a colon: phrases
  // such as "成年海獭九九：真实海獭比例……" are visual descriptions.
  if (names.length) {
    const named = new RegExp(`(?:^|[。！？!?；;，,：:\\n])\\s*(?:${names.join("|")})(?:[（(][^）)\\n]{0,40}[）)])?\\s*[：:]\\s*([^\\n]+)`, "gimu");
    for (const match of source.matchAll(named)) append(match[1]);
  }
  return [...new Set(result)];
}
export function dialogueFindings(source: string, result: string, speakerNames: string[] = []): VideoPromptFinding[] {
  const generated = normalize(result);
  return extractVideoDialogue(source, speakerNames).filter((speech) => !generated.includes(normalize(speech)))
    .map((speech) => ({ code: "DIALOGUE_CHANGED", severity: "warning", field: "dialogue", expected: speech, suggestion: "恢复这句对白；动作和剪辑说明应与对白分开", message: `提示词遗漏或改写了源分镜台词：“${speech}”` }));
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
  const namedResult: Array<{ name: string; speech: string; offscreen: boolean }> = [];
  for (const name of [...new Set(speakerNames)].filter(Boolean)) {
    const pattern = new RegExp(`${escaped(name)}(?:[（(]([^）)\\n]{0,30})[）)])?(?:在画外)?(?:说|说道|问|回答)?[：:]\\s*(?:[『「“\"]([^』」”\"\\n]+)[』」”\"]|([^\\n]+))`, "gu");
    for (const match of result.matchAll(pattern)) {
      const prefix = match[0].split(/[：:]/u)[0];
      namedResult.push({ name, speech: normalize(match[2] ?? dialogueText(match[3] ?? "", speakerNames)), offscreen: /画外|旁白|VO|OS/iu.test(`${match[1] ?? ""}${prefix}`) });
    }
  }
  const check = (name: string, text: string, offscreen: boolean, quoted = false) => {
    const speech = normalize(quoted ? text : dialogueText(text, speakerNames));
    const index = normalized.indexOf(speech);
    if (!speech || index < 0) return; // Missing speech is reported separately.
    const attributed = namedResult.find((item) => item.speech === speech);
    if (attributed) {
      if (attributed.name !== name) findings.push({ code: "SPEAKER_CHANGED", severity: "warning", field: "speaker", message: `源说话人 ${name} 的对白被标给了 ${attributed.name}` });
      else if (offscreen && !attributed.offscreen) findings.push({ code: "OFFSCREEN_SPEECH_CHANGED", severity: "warning", field: "speaker", message: `${name} 的画外对白缺少画外标记` });
      return;
    }
    const vicinity = normalized.slice(Math.max(0, index - 70), index + speech.length + 30);
    if (!vicinity.includes(normalize(name))) findings.push({ code: "SPEAKER_CHANGED", severity: "warning", field: "speaker", message: `对白缺少源说话人 ${name} 的对应标注` });
    if (offscreen && !/画外|旁白|vo|os/iu.test(vicinity)) findings.push({ code: "OFFSCREEN_SPEECH_CHANGED", severity: "warning", field: "speaker", message: `${name} 的画外对白缺少画外标记` });
  };
  const tags = /(?:画外音|旁白|对白|台词)[（(]([^）)\n]+)[）)]\s*[：:]\s*(?:[『「“"]([^』」”"\n]+)[』」”"]|([^\n]+))/gu;
  for (const match of source.matchAll(tags)) {
    const attributes = match[1].split(/[，,、]/u).map((item) => item.trim());
    const name = speakerNames.find((candidate) => attributes.includes(candidate)) ?? attributes.find((item) => !/^(?:画外|画内|画外音|旁白|VO|OS|男声|女声|低声|低沉|轻柔|苍老|平静)$/iu.test(item));
    if (name) check(name, match[2] ?? match[3] ?? "", /画外|旁白|VO|OS/iu.test(match[0].split(/[：:]/u)[0]), match[2] != null);
  }
  for (const name of [...new Set(speakerNames)].filter(Boolean)) {
    const pattern = new RegExp(`${escaped(name)}(?:[（(]([^）)\\n]{0,30})[）)])?(?:说|说道|问|回答)?[：:]\\s*(?:[『「“\"]([^』」”\"\\n]+)[』」”\"]|([^\\n]+))`, "gu");
    for (const match of source.matchAll(pattern)) check(name, match[2] ?? match[3] ?? "", /画外|旁白|VO|OS/iu.test(match[1] ?? ""), match[2] != null);
  }
  return findings;
}
