/** Preserve useful model-specific format advice without feeding the old XML
 * protocol back into the new server-owned storyboard input contract. */
export function videoPromptSystem(reference?: string): string {
  return `你为当前一个视频片段编写可直接提交模型的提示词。仅输出提示词正文，不声称生成了视频。
下方专业模板仅供表达形式参考：
<professional_reference>
${reference ?? ""}
</professional_reference>

当前输入协议优先：输入是服务器读取的本轨道全部源分镜，以及“已选参考”和“语义身份”。它不是旧版十二字段 XML，不能因格式不同而忽略源内容。
1. 同时读取源分镜的画面、动作、镜头说明和台词。逐字保留对白与说话人，区分画内/画外；有台词时不能输出“无台词”。无直接资产参考不等于没有角色，不要用“一名角色”代替已明确的名字、物种和外形。
2. 参考图只用于视觉参考；不能把它来源的其他片段台词或情节替换本片段剧情。参考编号严格遵循已选参考的实际顺序；语义身份描述不表示额外上传了图片，不给未提供的图片编造编号。
3. 原定对白和关键动作必须在源分镜时间内完成。若模型最低时长更长，额外尾段仅自然静持、无新对白/情节，便于按脚本剪辑；不以加速动作改变原节奏。
4. 保持已选风格和角色身份。只在剧情明确要求时允许本体与记忆/镜像同框，不能用模板“禁止分身”的通用规则删掉这种剧情。
5. 只描述本镜应见内容；不要把画外声音的角色硬画入镜，不新增未要求的人物。字幕如交由后期制作，不要求模型直接烧录；不得因此丢失对白。
6. 音色、性别和年龄只能依据已绑定音频或明确角色设定。未提供时使用角色名字，不自行补成“少女/女声/少年/男声”或使用带性别的人称；尤其不能把非人类神兽写成人类角色。缺少绑定音色时仅描述已确定的情绪、语气和发音要求，不编造固定音色设定。`;
}

/** Catch the concrete legacy failure where labelled source dialogue disappeared
 * completely. This is text validation, not a claim about generated speech. */
export function assertVideoPromptDialogue(source: string, result: string): void {
  const speech = /(?:对白|台词|画外音|旁白|内心OS|VO|OS|说|问|回答)[^。！？!?\n『「“"]{0,30}[：:]\s*[^『「“"\n]{0,20}[『「“"]([^』」”"\n]+)[』」”"]/giu;
  const normalize = (text: string) => text.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "").toLowerCase();
  const generated = normalize(result);
  for (const match of source.matchAll(speech)) {
    if (!generated.includes(normalize(match[1]))) throw new Error(`提示词遗漏或改写了源分镜台词：${match[1]}`);
  }
}
