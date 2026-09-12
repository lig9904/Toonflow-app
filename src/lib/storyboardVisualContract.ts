export interface VisualAsset {
  id: number;
  assetsId?: number | null;
  name: string;
  type?: string;
  describe?: string;
  desc?: string;
}

export class StoryboardVisualError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

/** Legacy rows can contain spoken dialogue in the image field. Keep their stored
 * text intact; only remove explicitly labelled speech from the image request. */
export function visualText(value: unknown, speakerNames: readonly string[] = []): string {
  let text = String(value ?? "");
  const quoted = "(?:『[^』]*』|「[^」]*」|“[^”]*”|\"[^\"]*\")";
  text = text.replace(new RegExp(`(?:对白|台词|旁白|画外音|内心独白|VO|OS)[（(][^）)]*[）)]\\s*[：:]?\\s*${quoted}`, "giu"), "");
  text = text.replace(new RegExp(`(?:对白|台词|旁白|画外音|内心独白|VO|OS|说|问|回答|喊道|说道)\\s*[：:]\\s*${quoted}`, "giu"), "");
  // New structured video descriptions may retain dialogue without quotation
  // marks. A known speaker at a sentence boundary makes the remainder of that
  // line audio content; omit it from still-image conditioning only. The visual
  // field remains the authoritative composition and the stored video text is
  // untouched. Do not treat a sign containing a character name as a speaker.
  const speakers = [...new Set(speakerNames.filter((name) => name.trim()).map(escaped))].sort((a, b) => b.length - a.length);
  const labels = ["对白", "台词", "旁白", "画外音", "内心独白", ...speakers].join("|");
  text = text.replace(new RegExp(`(^|[。！？；;\\n])\\s*(?:${labels})(?:[（(][^）)\\n]*[）)])?\\s*[：:][^\\n]*`, "gmu"), "$1");
  // A dedicated sound/off-screen line is not a visible character instruction.
  text = text.split(/\r?\n/).filter((line) => !/^\s*(?:对白|台词|旁白|画外音|内心独白|音效|声音|配音|VO\b|OS\b)\s*[：:（(]/iu.test(line)).join("\n");
  return text.replace(/[，,；;]\s*[，,；;]/g, "，").replace(/^[，,；;\s]+|[，,；;\s]+$/g, "").trim();
}

function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function visibleMentions(text: string, name: string): boolean {
  if (typeof name !== "string" || !name.trim()) return false;
  const pattern = new RegExp(escaped(name), "gu");
  return [...text.matchAll(pattern)].some((match) => {
    const start = match.index!;
    // Avoid matching e.g. Ann inside Anna, or a one-character name in prose.
    if (/^[\x00-\x7f]+$/.test(name) && /[\p{L}\p{N}_]/u.test(text[start - 1] ?? "")) return false;
    if (/^[\x00-\x7f]+$/.test(name) && /[\p{L}\p{N}_]/u.test(text[start + name.length] ?? "")) return false;
    const before = text.slice(Math.max(0, start - 10), start);
    const after = text.slice(start + name.length, start + name.length + 25);
    return !/(?:不出现|不显示|不描绘|不画出|不要画|不画|去掉|移除|禁止出现)\s*$/u.test(before)
      && !/(?:画外|画外音|旁白|VO|OS)[（(:：\s]*$/iu.test(before)
      && !/^\s*(?:[（(](?:画外|画外音|旁白|VO|OS)|仅(?:有)?画外|不入画|不出镜|在画外|的画外)/iu.test(after);
  });
}

/** Complete only exact, unambiguous known identities; never invent an asset or
 * guess which of two same-name characters/variants the author meant. */
export function reconcileStoryboardAssetIds(input: { prompt?: unknown; videoDesc?: unknown; associateAssetsIds: number[] }, assets: VisualAsset[]): number[] {
  const byId = new Map(assets.map((asset) => [Number(asset.id), asset]));
  let ids = [...new Set(input.associateAssetsIds.map(Number))];
  if (ids.some((id) => !byId.has(id))) throw new StoryboardVisualError("分镜引用了当前素材范围外的 ID");
  const text = visualText(input.prompt);
  const visualAssets = assets.filter((asset) => !["audio", "video"].includes(String(asset.type)));
  const names = [...new Set(visualAssets.map((asset) => String(asset.name ?? "").trim()).filter((name) => name.length > 1))].sort((a, b) => b.length - a.length);
  let remaining = text;
  const explicitlyMentionedVariantParents = new Set<number>();
  for (const name of names) {
    if (!visibleMentions(remaining, name)) continue;
    const candidates = visualAssets.filter((asset) => String(asset.name ?? "").trim() === name);
    const linked = candidates.filter((asset) => ids.includes(Number(asset.id)));
    const covered = candidates.filter((asset) => !explicitlyMentionedVariantParents.has(Number(asset.id)) && ids.some((id) => Number(byId.get(id)?.assetsId) === Number(asset.id)));
    if (!linked.length && !covered.length) {
      if (candidates.length !== 1) throw new StoryboardVisualError(`分镜中的“${name}”对应多个素材，请在画布明确选用的版本`);
      ids.push(Number(candidates[0].id));
    }
    remaining = remaining.replace(new RegExp(escaped(name), "gu"), " ");
    for (const asset of candidates) if (asset.assetsId != null) {
      explicitlyMentionedVariantParents.add(Number(asset.assetsId));
      const parent = byId.get(Number(asset.assetsId));
      if (candidates.length === 1 && parent && !visibleMentions(remaining, parent.name)) ids = ids.filter((id) => id !== Number(parent.id));
    }
  }
  return ids;
}

/** Extract the selected style's compact rendering tags instead of sending its
 * filesystem key or the full multi-page, role-specific prompt template. */
export function visualStyleHint(styleName: string, guide: string): string {
  const localized = guide.split(/\r?\n/).find((line) => /Seedance.*中文/.test(line));
  const tags = localized?.match(/`([^`]+)`/)?.[1];
  return tags || (styleName && styleName !== "无" ? styleName : "");
}

/** A still frame cannot simultaneously depict later cuts/actions from a video timeline. */
export function initialStoryboardFrame(text: string): string {
  const explicit=text.match(/(?:起始画面|首帧画面|开始画面)[：:]([^\n]+)/u)?.[1];
  const source=explicit?.trim()||text;
  const boundary=source.search(/(?:随后|随即|接着|然后|最后|末尾|转场|硬切|切到|切至|切换至)/u);
  return (boundary>0?source.slice(0,boundary):source).replace(/[，,；;\s]+$/u,"").trim();
}

export function buildStoryboardImagePrompt(input: {
  prompt: unknown; videoDesc?: unknown; assets: VisualAsset[]; style?: string; instruction?: string;
}): string {
  const speakers = input.assets.filter((asset) => asset.type === "role").map((asset) => asset.name);
  const picture = initialStoryboardFrame(visualText(input.prompt, speakers));
  if (!picture) throw new StoryboardVisualError("分镜缺少可用于出图的画面描述");
  // Full video actions remain exclusively in buildStoryboardVideoPrompt.
  const camera = /特写|近景|中景|全景|远景|微距|\d+\s*mm/i.test(picture) ? "" : initialStoryboardFrame(visualText(input.videoDesc, speakers));
  const composition = /极特写|微距/.test(`${picture}\n${camera}`)
    ? "取景约束：极特写或微距，仅展示本镜头指定的局部细节，不为完整展示参考素材而拉远。"
    : /特写|近景/.test(`${picture}\n${camera}`) && !/全景|远景/.test(picture)
      ? "取景约束：特写或近景，画面描述指定的局部主体占据画面，不擅自替换为其他主体，不要改成全身站姿展示；只在本镜头明确要求时让角色入画。"
      : "取景约束：按本镜头构图合理裁切参考素材，不要求把参考图中的全身或全部物件同时展示。";
  const references = input.assets.map((asset, index) => `参考图${index + 1}（@图${index + 1}）=${asset.name || `素材${asset.id}`}：${asset.describe || asset.desc || "严格保持该参考图中的身份与外形"}；用途：${asset.type === "role" ? "仅参考角色身份与外形，不复制多视图排版" : asset.type === "scene" ? "参考环境与空间，不添加无关人物" : "参考道具外形与材质"}`);
  return [
    "生成一张视频开始时的首帧静态画面，不把后续切镜、冲击波、离场等时序动作合并进这一帧。后续才出现的角色不要求在首帧入画。参考图只定义对应素材，不复制设定图的多视图排版。角色的物种、年龄、性别、发色、服饰和体型必须保持参考设定；不新增未要求的角色。",
    ...references,
    `画面：${picture}`,
    camera && camera !== picture ? `镜头与动作补充（仅表现可见部分）：${camera}` : "",
    composition,
    input.style ? `视觉风格：${input.style}` : "",
    input.instruction ? `本次画面调整：${visualText(input.instruction)}；只调整明确指定部分，未指定的角色身份、画风与场景保持一致。` : "",
    "对白、旁白和音效不绘制成文字；除画面明确要求的标牌、屏幕等文字外，不添加字幕、气泡、标题或水印。仅按镜头构图取景，未入画或只在画外发声的角色不要画出。",
  ].filter(Boolean).join("\n");
}

/** Both picture and video descriptions carry content in existing workspaces;
 * choosing one with || silently loses either action/dialogue or camera notes. */
export function buildStoryboardVideoPrompt(rows: Array<{ prompt?: unknown; videoDesc?: unknown; duration?: unknown }>): string {
  return rows.map((row, index) => {
    const parts = [...new Set([String(row.prompt ?? "").trim(), String(row.videoDesc ?? "").trim()].filter(Boolean))];
    return `镜头${index + 1}（${Number(row.duration) || 0}秒）：${parts.join("\n")}`;
  }).join("\n\n");
}
