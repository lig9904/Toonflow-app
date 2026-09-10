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
export function visualText(value: unknown): string {
  let text = String(value ?? "");
  const quoted = "(?:『[^』]*』|「[^」]*」|“[^”]*”|\"[^\"]*\")";
  text = text.replace(new RegExp(`(?:对白|台词|旁白|画外音|内心独白|VO|OS)[（(][^）)]*[）)]\\s*[：:]?\\s*${quoted}`, "giu"), "");
  text = text.replace(new RegExp(`(?:对白|台词|旁白|画外音|内心独白|VO|OS|说|问|回答|喊道|说道)\\s*[：:]\\s*${quoted}`, "giu"), "");
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

export function buildStoryboardImagePrompt(input: {
  prompt: unknown; videoDesc?: unknown; assets: VisualAsset[]; style?: string; instruction?: string;
}): string {
  const picture = visualText(input.prompt);
  if (!picture) throw new StoryboardVisualError("分镜缺少可用于出图的画面描述");
  const camera = visualText(input.videoDesc);
  const references = input.assets.map((asset, index) => `参考图${index + 1}（@图${index + 1}）=${asset.name || `素材${asset.id}`}：${asset.describe || asset.desc || "严格保持该参考图中的身份与外形"}`);
  return [
    "生成一张单镜头画面。参考图只定义对应素材，不复制设定图的多视图排版。角色的物种、年龄、性别、发色、服饰和体型必须保持参考设定；不新增未要求的角色。",
    ...references,
    `画面：${picture}`,
    camera && camera !== picture ? `镜头与动作补充（仅表现可见部分）：${camera}` : "",
    input.style ? `视觉风格：${input.style}` : "",
    input.instruction ? `本次画面调整：${visualText(input.instruction)}` : "",
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
