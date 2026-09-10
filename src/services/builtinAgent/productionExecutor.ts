import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import type { BuiltinExecutionContext } from "../builtinAgentRuntime";
import { BuiltinRuntimeError } from "../builtinAgentRuntime";
import { readProductionFlow, saveProductionPlanning, addProductionStoryboards, type NewStoryboard } from "../productionFlow";
import { createOrUpdateDerivedAsset } from "../productionAssets";
import { ProductionStateService } from "../productionState";
import type { AiType } from "../../utils/ai";
import type { StructuredModelRequest, StructuredScriptModel } from "./scriptExecutor";
import { createAssetExtractionHelper } from "./assetExtraction";
import { getCreativeState } from "../creativeWorkspace";
import pLimit from "p-limit";
import { builtinThinkLevelFromIntent, hasIndependentProductionOutput, hasUnlimitedMediaBudget } from "./contracts";
import { productionActionLabels, productionDecisionPrompt, productionStageContract, explicitProductionTextScope } from "./productionPrompts";
import { reconcileStoryboardAssetIds, buildStoryboardVideoPrompt } from "../../lib/storyboardVisualContract";

export interface ProductionMediaRequest {
  ctx: BuiltinExecutionContext;
  projectId: number;
  scriptId: number;
  targetKind: "asset" | "storyboard" | "track";
  targetId: number;
  storyboardId?: number;
  modelKey: string;
  generationKey: string;
  params: Record<string, unknown>;
}

export interface ProductionMediaCapability {
  generateImage?(request: ProductionMediaRequest): Promise<unknown>;
  generateVideo?(request: ProductionMediaRequest): Promise<unknown>;
}

export interface ProductionExecutorDependencies {
  db: Knex;
  model: StructuredScriptModel;
  loadSkill(name: string): Promise<string>;
  visualStyleGuide?(styleName: string): string;
  directorGuide?(name: string): string;
  media?: ProductionMediaCapability;
  videoModelMetadata?: (modelKey: string) => Promise<{ mode?: unknown; resolution?: unknown; audio?: unknown }>;
}

const phase = z.enum(["extractAssets", "planning", "directorPlan", "deriveAssets", "storyboard", "storyboardTable", "generateImages", "generateVideos", "review"]);
const planSchema = z.object({
  actions: z.array(phase).max(9),
  assetIds: z.array(z.number().int().positive()).max(500).default([]),
  storyboardIds: z.array(z.number().int().positive()).max(500).default([]),
  globalMediaInstructions: z.string().max(20_000).default(""),
  mediaInstructions: z.array(z.object({
    targetKind: z.enum(["asset", "storyboard", "track"]),
    targetId: z.number().int().positive(),
    instructions: z.string().max(20_000),
  }).strict()).max(1000).default([]),
  question: z.string().max(2000).nullable().default(null),
  summary: z.string().max(4000),
  videoSettings: z.object({ resolution: z.string().max(50).nullable().default(null), audio: z.boolean().nullable().default(null) }).strict().nullable().default(null),
}).strict();
const planningSchema = z.object({ scriptPlan: z.string().min(1).max(200_000) }).strict();
const deriveSchema = z.object({ assets: z.array(z.object({ id: z.number().int().positive().nullable().default(null), expectedVersion: z.number().int().nonnegative().nullable().default(null), parentAssetId: z.number().int().positive(), name: z.string().trim().min(1).max(500), description: z.string().max(20_000) }).strict()).max(500) }).strict();
const storyboardSchema = z.object({
  items: z.array(z.object({
    id: z.number().int().positive().nullable().default(null),
    prompt: z.string().max(20_000).describe("图片的可见画面：景别、构图、角色、动作、场景、道具；对白和画外声音放 videoDesc"), duration: z.number().positive().max(300), track: z.string().trim().min(1).max(100),
    videoDesc: z.string().max(20_000).describe("完整视频动作、运镜和声音；台词逐字保留，明确说话人及画外声音"), shouldGenerateImage: z.number().int().min(0).max(1),
    associateAssetsIds: z.array(z.number().int().positive()).max(100).describe("本镜可见角色、场景、道具的真实素材ID，不能遗漏或只在场头引用"), expectedVersion: z.number().int().nonnegative().nullable().default(null),
  }).strict()).min(1).max(500),
  summary: z.string().max(4000),
}).strict();
const reviewSchema = z.object({ findings: z.array(z.string().max(4000)).max(100), summary: z.string().max(4000) }).strict();

type CanonicalPhase = "extractAssets" | "planning" | "deriveAssets" | "storyboard" | "generateImages" | "generateVideos" | "review";
const ORDER: CanonicalPhase[] = ["extractAssets", "planning", "deriveAssets", "storyboard", "generateImages", "generateVideos", "review"];
const canonical = (value: z.infer<typeof phase>): CanonicalPhase => value === "directorPlan" ? "planning" : value === "storyboardTable" ? "storyboard" : value as CanonicalPhase;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type MediaTarget = { targetKind: "asset" | "storyboard" | "track"; targetId: number; storyboardIds: number[]; source: any };

const scopedMediaInstructionPrompt = `
媒体要求分配契约：globalMediaInstructions 只能写所有目标共同适用的要求，例如画幅、整体色调、统一禁用项；mediaInstructions 必须按真实 targetKind/targetId 写单个目标的局部要求。不要把另一个分镜的人物、动作、对白或镜头景别写进全局要求。每个目标只能接收全局要求和自己的局部要求。`;

function validateMediaInstructions(
  plan: { assetIds: number[]; storyboardIds: number[]; mediaInstructions: Array<{ targetKind: "asset" | "storyboard" | "track"; targetId: number; instructions: string }> },
  knownAssets: Set<number>,
  knownStoryboards: Map<number, any>,
): void {
  const selectedAssets = new Set(plan.assetIds);
  const selectedStoryboards = new Set(plan.storyboardIds);
  const selectedTracks = new Set(
    plan.storyboardIds
      .map((id) => Number(knownStoryboards.get(id)?.trackId))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
  const seen = new Set<string>();
  for (const instruction of plan.mediaInstructions) {
    const targetId = Number(instruction.targetId);
    const key = `${instruction.targetKind}:${targetId}`;
    if (seen.has(key)) throw new BuiltinRuntimeError("INVALID_INPUT", `媒体局部要求重复指定目标 ${key}`);
    seen.add(key);
    const allowed = instruction.targetKind === "asset"
      ? knownAssets.has(targetId) && selectedAssets.has(targetId)
      : instruction.targetKind === "storyboard"
        ? knownStoryboards.has(targetId) && selectedStoryboards.has(targetId)
        : selectedTracks.has(targetId);
    if (!allowed) throw new BuiltinRuntimeError("INVALID_INPUT", `媒体局部要求目标 ${key} 不属于当前项目或本轮选中范围`);
  }
}

function scopedMediaInstructions(
  target: MediaTarget,
  globalInstructions: string,
  localInstructions: Map<string, string>,
  requestText: string,
  targetCount: number,
): string {
  const values = [globalInstructions.trim()];
  const keys = new Set([`${target.targetKind}:${target.targetId}`, ...target.storyboardIds.map((id) => `storyboard:${id}`)]);
  for (const key of keys) {
    const value = localInstructions.get(key)?.trim();
    if (value) values.push(value);
  }
  // Legacy plans may not have scoped fields. Keep the old request only for a
  // genuinely single target; multi-target runs must never cross-contaminate.
  if (values.every((value) => !value) && targetCount === 1) values.push(requestText.trim());
  return values.filter(Boolean).join("\n");
}

export function createProductionAgentExecutor(deps: ProductionExecutorDependencies) {
  const extractAssets = createAssetExtractionHelper({ db: deps.db, model: deps.model });
  return async (ctx: BuiltinExecutionContext): Promise<unknown> => {
    const { run } = ctx;
    if (run.agentType !== "productionAgent" || run.projectId == null || run.scriptId == null) throw new BuiltinRuntimeError("INVALID_INPUT", "制作任务需要项目和剧集");
    const projectId = run.projectId;
    const scriptId = run.scriptId;
    const revision = run.inputRevision ?? 0;
    const thinkLevel = builtinThinkLevelFromIntent(run.intent);
    const independentOutput = hasIndependentProductionOutput(run.agentType, run.intent);
    const requestText = run.continuation ? `${run.prompt}\n\n人工补充与续作要求：\n${run.continuation}` : run.prompt;
    const project = await ctx.step(`production.input:r${revision}`, { projectId, scriptId, requestText }, async () => {
      const row = await deps.db("o_project").where({ id: projectId }).first();
      const episode = await deps.db("o_script").where({ id: scriptId, projectId }).first();
      if (!row || !episode) throw new BuiltinRuntimeError("FORBIDDEN", "项目或剧集不属于当前任务");
      const scriptVersion = await getCreativeState(deps.db, "script", scriptId, projectId);
      return { id: projectId, scriptId, scriptVersion: scriptVersion.version, name: row.name ?? "", directorManual: row.directorManual ?? "", directorGuide: deps.directorGuide?.(row.directorManual ?? "") ?? "", artStyle: row.artStyle ?? "", visualStyleGuide: deps.visualStyleGuide?.(row.artStyle ?? "") ?? "", imageModel: row.imageModel ?? "", videoModel: row.videoModel ?? row.videoModelKey ?? "", imageQuality: row.imageQuality ?? "1K", videoRatio: row.videoRatio ?? "16:9", videoMode: row.mode ?? row.videoMode, videoResolution: row.videoResolution ?? row.resolution, audio: row.generateAudio ?? row.audio, script: episode.content ?? "" };
    });
    const assertSourceCurrent = async (db: Knex | Knex.Transaction, checkMedia = false) => {
      const currentScript = await db("o_script").where({ id: scriptId, projectId }).first();
      const currentProject = await db("o_project").where({ id: projectId }).first();
      if (!currentScript || !currentProject || String(currentScript.content ?? "") !== project.script
        || String(currentProject.directorManual ?? "") !== project.directorManual || String(currentProject.artStyle ?? "") !== project.artStyle) {
        throw new BuiltinRuntimeError("CONFLICT", "剧本或导演/风格设定已被修改，本次旧结果未写入；请基于最新画布继续制作");
      }
      if (checkMedia && (String(currentProject.imageModel ?? "") !== project.imageModel || String(currentProject.videoModel ?? currentProject.videoModelKey ?? "") !== project.videoModel
        || String(currentProject.imageQuality ?? "1K") !== project.imageQuality || String(currentProject.videoRatio ?? "16:9") !== project.videoRatio
        || (currentProject.mode ?? currentProject.videoMode) !== project.videoMode || (currentProject.videoResolution ?? currentProject.resolution) !== project.videoResolution
        || (currentProject.generateAudio ?? currentProject.audio) !== project.audio)) throw new BuiltinRuntimeError("CONFLICT", "项目媒体配置已被修改，本次旧生成请求已停止");
      const capturedAssets = flow.assets.flatMap((asset: any) => [asset, ...asset.derive]);
      const currentAssets = capturedAssets.length ? await db("o_assets").where({ projectId }).whereIn("id", capturedAssets.map((asset: any) => asset.id)) : [];
      if (capturedAssets.some((asset: any) => {
        const current = currentAssets.find((row) => Number(row.id) === Number(asset.id));
        return !current || String(current.name ?? "") !== asset.name || String(current.describe ?? "") !== asset.desc || Number(current.assetsId ?? 0) !== Number(asset.assetsId ?? 0);
      })) throw new BuiltinRuntimeError("CONFLICT", "素材设定已被修改，本次旧结果未写入；请基于最新画布继续制作");
    };
    let flow = await ctx.step(`production.flow:r${revision}`, { projectId, scriptId }, () => readProductionFlow(deps.db, projectId, scriptId, async (path) => path));
    const refreshFlow = async (after: string) => {
      const read = () => readProductionFlow(deps.db, projectId, scriptId, async (path) => path);
      // A later completed stage may already have changed this workspace when a
      // worker resumes. Replay the original stage input, not our later writes.
      return independentOutput ? ctx.step(`production.flow.after.${after}:r${revision}`, { projectId, scriptId }, read) : read();
    };
    const skillCache = new Map<string, string>();
    const skill = async (name: string) => { if (!skillCache.has(name)) skillCache.set(name, await deps.loadSkill(name)); return skillCache.get(name)!; };
    const model = async <T>(key: string, role: StructuredModelRequest<T>["role"], skillName: string, schema: z.ZodType<T>, input: unknown, budget: number, reserveTokens = 0): Promise<T> => {
      if (!independentOutput && budget < 128) throw new BuiltinRuntimeError("BUDGET_EXCEEDED", "输出额度不足以执行制作阶段");
      await ctx.assertActive();
      const system = role === "productionAgent:decisionAgent" ? `${productionDecisionPrompt}\n${scopedMediaInstructionPrompt}`
        : `${await skill(skillName)}\n\n当前服务器执行契约（取代上述旧工具、XML和前端保存流程）：${productionStageContract(role)} 所有项目、剧集、素材、分镜 ID 必须来自输入。`;
      const result = await ctx.step(`production.${key}:r${revision}`, { input, role, systemHash: hash(system), ...(independentOutput ? { outputBudgetMode: "model_per_call" } : { budget, reserveTokens }) }, async () => {
        const remaining = !independentOutput && ctx.remainingOutputTokens ? await ctx.remainingOutputTokens() : run.limits.maxOutputTokens;
        const effectiveBudget = independentOutput ? 0 : Math.min(budget, remaining - reserveTokens);
        if (!independentOutput && effectiveBudget < 128) throw new BuiltinRuntimeError("BUDGET_EXCEEDED", "本次运行的剩余文本输出额度不足，请缩小下一步范围；已保存结果保留");
        const target = key === "directorPlan" ? "scriptPlan" : key === "storyboard" ? "storyboardTable" : undefined;
        let lastPreviewAt = 0, lastText = "";
        const preview = target ? async (partial: unknown) => {
          const value = partial as { scriptPlan?: unknown; items?: unknown[] } | null;
          const cell = (value: unknown) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
          const text = target === "scriptPlan" ? (typeof value?.scriptPlan === "string" ? value.scriptPlan : "")
            : Array.isArray(value?.items) ? ["| 镜头 | 时长（秒） | 画面 | 视频描述 |", "|---|---|---|---|", ...value.items.map((item: any, index) => `| ${index + 1} | ${cell(item?.duration)} | ${cell(item?.prompt)} | ${cell(item?.videoDesc)} |`)].join("\n") : "";
          if (!text || text === lastText || Date.now() - lastPreviewAt < 500) return;
          lastPreviewAt = Date.now(); lastText = text;
          await ctx.emit("artifact.preview", { target, text: text.slice(0, 200_000), inputRevision: revision });
        } : undefined;
        const generated = await deps.model.generate({ role, system, input, schema, maxOutputTokens: effectiveBudget, ...(independentOutput ? { useModelOutputLimit: true } : {}), ...(preview ? { onPartial: preview } : {}), signal: ctx.signal, thinkLevel });
        return { value: schema.parse(generated.value), outputTokens: generated.outputTokens, ...(generated.maxOutputTokens ? { maxOutputTokens: generated.maxOutputTokens } : {}) };
      }, { modelCall: true });
      return result.value;
    };
    const planBudget = Math.min(1800, Math.floor(run.limits.maxOutputTokens / 3));
    const plan = await model("plan", "productionAgent:decisionAgent", "production_agent_decision.md", planSchema, { request: requestText, project, flow,
      authorization: { maxImageGenerations: run.limits.maxImageGenerations, maxVideoGenerations: run.limits.maxVideoGenerations,
        imageUnlimited: hasUnlimitedMediaBudget(run, "image"), videoUnlimited: hasUnlimitedMediaBudget(run, "video") } }, planBudget);
    // Compatibility names describe the same operation, so canonicalize once.
    const requestedActions = new Set(plan.actions.map(canonical));
    const explicitTextScope = explicitProductionTextScope(requestText);
    if (explicitTextScope) {
      requestedActions.clear();
      for (const action of explicitTextScope) requestedActions.add(action);
    }
    const actions: CanonicalPhase[] = ORDER.filter((action) => requestedActions.has(action));
    let knownTopAssets = new Set(flow.assets.map((asset: any) => Number(asset.id)));
    let knownAssets = new Set(flow.assets.flatMap((asset: any) => [Number(asset.id), ...asset.derive.map((child: any) => Number(child.id))]));
    let knownStoryboards = new Map(flow.storyboard.map((storyboard: any) => [Number(storyboard.id), storyboard]));
    if (plan.assetIds.some((id) => !knownAssets.has(id)) || plan.storyboardIds.some((id) => !knownStoryboards.has(id))) throw new BuiltinRuntimeError("INVALID_INPUT", "制作规划引用了项目外实体");
    validateMediaInstructions(plan, knownAssets, knownStoryboards);
    if (plan.question && !actions.length) throw new BuiltinRuntimeError("INVALID_INPUT", `本次没有可执行的制作步骤：${plan.question}`);
    await ctx.emit("message.completed", { text: actions.length ? `准备执行：${actions.map((action) => productionActionLabels[action]).join("、")}。保存完成后会显示实际产物。` : "本轮未执行制作步骤，也未写入数据。" });
    const selected = new Set(actions);
    const remainingBudget = run.limits.maxOutputTokens - planBudget;
    if (!independentOutput && remainingBudget < actions.length * 128) throw new BuiltinRuntimeError("BUDGET_EXCEEDED", "输出额度不足以执行所选制作阶段");
    const textActionCount = actions.filter((action) => action !== "generateImages" && action !== "generateVideos").length;
    const budget = Math.floor(remainingBudget / Math.max(1, textActionCount));
    const output: Record<string, unknown> = { projectId, scriptId, revision, actions };
    const executionIssues: Array<Record<string, unknown>> = plan.question ? [{ message: plan.question }] : [];
    let targetAssetIds = [...new Set(plan.assetIds)];
    let targetStoryboardIds = [...new Set(plan.storyboardIds)];
    const unavailableStoryboardImages = new Set<number>();

    for (const action of ORDER) {
      if (!selected.has(action)) continue;
      if (action === "extractAssets") {
        const extraction = await extractAssets(ctx, { projectId, sourceScripts: [{ id: scriptId, expectedVersion: project.scriptVersion }], request: requestText, maxOutputTokens: budget, ...(independentOutput ? { useModelOutputLimit: true } : {}), stepKey: "production.extractAssets" });
        output.assets = extraction;
        targetAssetIds = extraction.assetIds;
        flow = await refreshFlow("extractAssets");
        knownTopAssets = new Set(flow.assets.map((asset: any) => Number(asset.id)));
        knownAssets = new Set(flow.assets.flatMap((asset: any) => [Number(asset.id), ...asset.derive.map((child: any) => Number(child.id))]));
      } else if (action === "planning") {
        const planResult = await model("directorPlan", "productionAgent:directorPlanAgent", "builtin_production_director.md", planningSchema, { request: requestText, project, flow }, textActionCount > 1 ? Math.min(4096, budget) : budget);
        const saved = await ctx.commit(`production.planning:r${revision}`, { projectId, scriptId, expected: flow.planningVersion, planResult }, async (trx) => {
          await assertSourceCurrent(trx);
          return saveProductionPlanning(trx as unknown as Knex, projectId, scriptId, flow.planningVersion, { scriptPlan: planResult.scriptPlan, storyboardTable: flow.storyboardTable });
        });
        output.planning = saved;
        flow = await refreshFlow("planning");
        await ctx.emit("artifact.saved", { kind: "productionPlanning", ids: [projectId, scriptId], version: saved.planningVersion });
      } else if (action === "deriveAssets") {
        const requestedParentIds = [...targetAssetIds];
        if (!targetAssetIds.length) {
          executionIssues.push({ action, message: "未确定衍生素材范围，已跳过该步骤；可直接在画布调整素材后重新发起制作。" });
          continue;
        }
        const derived = await model("deriveAssets", "productionAgent:deriveAssetsAgent", "builtin_production_derive.md", deriveSchema, { request: requestText, project, flow, parentAssetIds: targetAssetIds }, budget);
        const created = await ctx.commit(`production.assets:r${revision}`, { projectId, scriptId, derived }, async (trx) => {
          await assertSourceCurrent(trx);
          const ids: unknown[] = [];
          for (const item of derived.assets) {
            if (!knownTopAssets.has(item.parentAssetId) || !targetAssetIds.includes(item.parentAssetId)) throw new BuiltinRuntimeError("INVALID_INPUT", "衍生资产父 ID 必须是本次选定的项目顶层素材");
            if (item.id == null) {
              const sameName = flow.assets.find((asset: any) => Number(asset.id) === item.parentAssetId)?.derive.filter((child: any) => String(child.name).trim() === item.name.trim()) ?? [];
              if (sameName.length > 1) throw new BuiltinRuntimeError("CONFLICT", `同名衍生素材“${item.name}”不唯一，已停止重复创建`);
              if (sameName.length === 1) {
                const existing = await trx("o_assets").where({ id: sameName[0].id, projectId, assetsId: item.parentAssetId }).first();
                if (!existing || String(existing.name).trim() !== item.name.trim()) throw new BuiltinRuntimeError("CONFLICT", "衍生素材在分析期间已被修改或移除");
                ids.push({ id: Number(existing.id), reused: true });
                continue;
              }
            }
            const captured = item.id == null ? undefined : flow.assets.flatMap((asset: any) => asset.derive).find((asset: any) => Number(asset.id) === item.id);
            if (item.id != null && (!captured || (item.expectedVersion != null && item.expectedVersion !== Number(captured.version ?? 0)))) throw new BuiltinRuntimeError("CONFLICT", "衍生素材已不在读取范围或模型返回了错误版本");
            ids.push(await createOrUpdateDerivedAsset(trx as unknown as Knex, { projectId, scriptId, parentAssetId: item.parentAssetId, id: item.id ?? undefined,
              expectedVersion: captured ? Number(captured.version ?? 0) : undefined, actor: { id: `agent:${run.id}`, kind: "agent" }, name: item.name, description: item.description }));
          }
          return ids;
        });
        output.derivedAssets = created;
        const savedAssetIds = (created as Array<{ id: number; reused?: boolean }>).filter((item) => !item.reused).map((item) => Number(item.id));
        targetAssetIds = savedAssetIds;
        flow = await refreshFlow("deriveAssets");
        knownTopAssets = new Set(flow.assets.map((asset: any) => Number(asset.id)));
        knownAssets = new Set(flow.assets.flatMap((asset: any) => [Number(asset.id), ...asset.derive.map((child: any) => Number(child.id))]));
        if (selected.has("generateImages")) targetAssetIds = [...new Set([...targetAssetIds, ...flow.assets.filter((asset: any) => requestedParentIds.includes(Number(asset.id))).flatMap((asset: any) => asset.derive.filter((child: any) => !child.src).map((child: any) => Number(child.id)))])];
        if (savedAssetIds.length) await ctx.emit("artifact.saved", { kind: "assets", ids: savedAssetIds });
        else await ctx.emit("message.completed", { text: targetAssetIds.length && selected.has("generateImages") ? `衍生描述已存在，准备生成 ${targetAssetIds.length} 个缺失的衍生素材图片。` : "衍生素材分析完成，本次没有新增或更新衍生版本。" });
        if (savedAssetIds.length && !selected.has("generateImages")) await ctx.emit("message.completed", { text: `已保存 ${savedAssetIds.length} 个衍生素材描述，本次没有生成图片。需要出图时可授权图片次数并生成衍生素材图片。` });
      } else if (action === "storyboard") {
        // Long shot lists can use tokens left over from the compact director plan.
        const storyboard = await model("storyboard", "productionAgent:storyboardTableAgent", "builtin_production_storyboard.md", storyboardSchema, { request: requestText, project, flow, selectedStoryboardIds: plan.storyboardIds }, run.limits.maxOutputTokens, selected.has("review") ? 1024 : 0);
        const created = await ctx.commit(`production.storyboard.commit:r${revision}`, { projectId, scriptId, storyboard }, async (trx) => {
          await assertSourceCurrent(trx);
          const visualAssets = flow.assets.flatMap((asset: any) => [asset, ...asset.derive]);
          const additions: NewStoryboard[] = [];
          const existingIds: number[] = [];
          for (const item of storyboard.items) {
            if (item.associateAssetsIds.some((id) => !knownAssets.has(id))) throw new BuiltinRuntimeError("INVALID_INPUT", "分镜引用了项目外素材");
            item.associateAssetsIds = reconcileStoryboardAssetIds(item, visualAssets);
            if (item.id == null) { additions.push({ prompt: item.prompt, duration: item.duration, track: item.track, videoDesc: item.videoDesc, shouldGenerateImage: item.shouldGenerateImage, associateAssetsIds: item.associateAssetsIds }); continue; }
            const old = knownStoryboards.get(item.id);
            if (!old) throw new BuiltinRuntimeError("INVALID_INPUT", "分镜 ID 不属于当前剧集");
            const capturedVersion = Number(old.collaboration?.version ?? 0);
            if (item.expectedVersion != null && item.expectedVersion !== capturedVersion) throw new BuiltinRuntimeError("CONFLICT", "模型返回的分镜版本不是读取时版本");
            existingIds.push(item.id);
          }
          if (existingIds.length) {
            const states = new ProductionStateService(trx as unknown as Knex);
            await states.guardStoryboardMutations({ projectId, storyboardIds: existingIds, expectedVersions: Object.fromEntries(existingIds.map((id) => [id, Number(knownStoryboards.get(id)!.collaboration?.version ?? 0)])), actor: { id: `agent:${run.id}`, kind: "agent" }, mutate: async (guardedTrx) => {
              for (const item of storyboard.items.filter((candidate) => candidate.id != null)) {
                const assetIds = [...new Set(item.associateAssetsIds)];
                // Existing storyboard IDs are the stable identity. Preserve
                // their persisted track binding (and therefore the track's
                // prompt/history/lock) even when the model changes the human
                // readable `track` label. Only addProductionStoryboards may
                // create a track for genuinely new storyboard rows.
                const existing = knownStoryboards.get(Number(item.id));
                const existingTrackId = Number(existing?.trackId);
                const trackId = Number.isSafeInteger(existingTrackId) && existingTrackId > 0 ? existingTrackId : existing?.trackId ?? null;
                await guardedTrx("o_storyboard").where({ id: item.id, projectId, scriptId }).update({ prompt: item.prompt, videoDesc: item.videoDesc, duration: String(item.duration), track: item.track, trackId, shouldGenerateImage: item.shouldGenerateImage });
                await guardedTrx("o_assets2Storyboard").where({ storyboardId: item.id }).del();
                if (assetIds.length) await guardedTrx("o_assets2Storyboard").insert(assetIds.map((assetId) => ({ assetId, storyboardId: item.id })));
              }
              return undefined;
            }});
          }
          const newIds = additions.length ? await addProductionStoryboards(trx as unknown as Knex, projectId, scriptId, additions) : [];
          const rows = await trx("o_storyboard").where({ projectId, scriptId }).orderBy("index").orderBy("id").select("id", "prompt", "videoDesc", "duration");
          const cell = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
          const table = ["| 镜头 | ID | 时长（秒） | 画面 | 视频描述 |", "|---|---|---|---|---|", ...rows.map((row, index) => `| ${index + 1} | ${row.id} | ${cell(row.duration)} | ${cell(row.prompt)} | ${cell(row.videoDesc)} |`)].join("\n");
          await saveProductionPlanning(trx as unknown as Knex, projectId, scriptId, flow.planningVersion, { scriptPlan: flow.scriptPlan, storyboardTable: table });
          return [...existingIds, ...newIds];
        });
        output.storyboardIds = created;
        targetStoryboardIds = created;
        flow = await refreshFlow("storyboard");
        knownStoryboards = new Map(flow.storyboard.map((storyboard: any) => [Number(storyboard.id), storyboard]));
        await ctx.emit("artifact.saved", { kind: "storyboards", ids: created });
      } else if (action === "generateImages" || action === "generateVideos") {
        if (!deps.media || (action === "generateImages" ? typeof deps.media.generateImage !== "function" : typeof deps.media.generateVideo !== "function")) throw new BuiltinRuntimeError("INVALID_INPUT", `${action} 媒体能力未配置，不能声称已完成`);
        const storyboardIds = targetStoryboardIds;
        const assetIds = action === "generateImages" ? targetAssetIds : [];
        const targets: MediaTarget[] = [];
        if (action === "generateVideos") {
          const grouped = new Map<number, number[]>();
          for (const id of storyboardIds) { const trackId = Number(knownStoryboards.get(id)?.trackId); if (!Number.isSafeInteger(trackId) || trackId <= 0) throw new BuiltinRuntimeError("INVALID_INPUT", "视频生成分镜缺少有效轨道 ID"); grouped.set(trackId, [...(grouped.get(trackId) ?? []), id]); }
          for (const [trackId, ids] of grouped) targets.push({ targetKind: "track", targetId: trackId, storyboardIds: ids, source: knownStoryboards.get(ids[0]) });
        } else {
          targets.push(...assetIds.map((id) => ({ targetKind: "asset" as const, targetId: id, storyboardIds: [], source: flow.assets.flatMap((asset: any) => [asset, ...asset.derive]).find((asset: any) => Number(asset.id) === id) })));
          targets.push(...storyboardIds.map((id) => ({ targetKind: "storyboard" as const, targetId: id, storyboardIds: [id], source: knownStoryboards.get(id) })));
        }
        const limit = action === "generateImages" ? run.limits.maxImageGenerations : run.limits.maxVideoGenerations;
        if (action === "generateImages" && selected.has("deriveAssets") && !targets.length) {
          output.generateImages = [];
          await ctx.emit("message.completed", { text: "本次没有需要出图的衍生素材，未调用图片模型。" });
          continue;
        }
        if (!targets.length) {
          executionIssues.push({ action, message: "没有可生成的素材、分镜或视频轨道，已跳过该步骤。" });
          continue;
        }
        if (!hasUnlimitedMediaBudget(run, action === "generateImages" ? "image" : "video") && targets.length > limit) throw new BuiltinRuntimeError("BUDGET_EXCEEDED", `${action} 超过本次运行生成数量上限`);
        if (targets.some((item) => !item.source)) throw new BuiltinRuntimeError("INVALID_INPUT", "媒体生成引用了项目外实体");
        const results: unknown[] = [];
        const issues: Array<{ targetKind: string; targetId: number; message: string; result?: unknown }> = [];
        const globalMediaInstructions = plan.globalMediaInstructions.trim();
        const localMediaInstructions = new Map(plan.mediaInstructions.map((item) => [`${item.targetKind}:${item.targetId}`, item.instructions]));
        const performTarget = async (target: MediaTarget) => {
          await ctx.assertActive();
          await assertSourceCurrent(deps.db, true);
          const source = target.source as any;
          // A human answer or worker restart resumes the same generation. A new
          // generation of this target requires a new run with its own allowance.
          const generationKey = `builtin:${run.id}:${action}:${target.targetKind}:${target.targetId}`;
          const videoMetadata = action === "generateVideos" && deps.videoModelMetadata ? await deps.videoModelMetadata(project.videoModel) : {};
          const videoSources = action === "generateVideos" ? target.storyboardIds.map((id) => knownStoryboards.get(id)).filter(Boolean) as any[] : [];
          const storedVideoPrompt = buildStoryboardVideoPrompt(videoSources);
          const storedImagePrompt = target.targetKind === "asset" && selected.has("deriveAssets") ? source.desc || source.prompt || source.name || "" : source.prompt || source.desc || source.name || "";
          const scopedInstructions = scopedMediaInstructions(target, globalMediaInstructions, localMediaInstructions, requestText, targets.length);
          const imageRequest = scopedInstructions;
          const videoInstruction = scopedInstructions ? `本目标媒体要求（仅适用于当前目标）：${scopedInstructions}` : "";
          const videoParams: Record<string, unknown> = action === "generateVideos" ? {
            mode: project.videoMode || videoMetadata.mode,
            resolution: plan.videoSettings?.resolution ?? project.videoResolution ?? videoMetadata.resolution,
            duration: videoSources.reduce((total, item) => total + Number(item.duration || 0), 0),
            audio: plan.videoSettings?.audio ?? project.audio ?? videoMetadata.audio ?? false,
            prompt: [storedVideoPrompt, videoInstruction].filter(Boolean).join("\n"),
            storyboardIds: target.storyboardIds,
            expectedVersions: Object.fromEntries(videoSources.map((item) => [Number(item.id), Number(item.collaboration?.version ?? 0)])),
          } : { prompt: [storedImagePrompt, project.artStyle ? `画风：${project.artStyle}` : "", imageRequest ? `本目标画面要求：${imageRequest}` : ""].filter(Boolean).join("\n"), imageInstruction: imageRequest, size: project.imageQuality, aspectRatio: project.videoRatio,
            expectedVersion: target.targetKind === "storyboard" ? Number(source.collaboration?.version ?? 0) : Number(source.imageId ?? 0),
            referenceAssetIds: target.targetKind === "storyboard" ? source.associateAssetsIds ?? [] : source.assetsId != null ? [Number(source.assetsId)] : Number(source.imageId ?? 0) > 0 ? [target.targetId] : [],
            referenceStoryboardIds: [] };
          if (action === "generateVideos" && (videoParams.mode === undefined || videoParams.resolution === undefined || Number(videoParams.duration) <= 0 || !videoParams.prompt)) throw new BuiltinRuntimeError("INVALID_INPUT", "视频生成缺少已验证的模式、分辨率、时长或提示词");
          const result = await ctx.step(`production.${action}:${target.targetKind}:${target.targetId}`, { projectId, scriptId, targetKind: target.targetKind, targetId: target.targetId, generationKey }, () => action === "generateImages" ? deps.media!.generateImage!({ ctx, projectId, scriptId, targetKind: target.targetKind, targetId: target.targetId, storyboardId: target.targetKind === "storyboard" ? target.targetId : undefined, modelKey: project.imageModel, generationKey, params: videoParams }) : deps.media!.generateVideo!({ ctx, projectId, scriptId, targetKind: "track", targetId: target.targetId, modelKey: project.videoModel, generationKey, params: videoParams }), { imageGeneration: action === "generateImages", videoGeneration: action === "generateVideos" });
          const status = mediaResultStatus(result);
          if (status === "pending") throw new BuiltinRuntimeError("INVALID_INPUT", `${action} callback must wait for final status before returning`);
          if (status === "needs_reconciliation") {
            if (!hasDurableReference(result)) throw new BuiltinRuntimeError("INVALID_INPUT", `${action} pending result lacks durable reference`);
            return { targetKind: target.targetKind, targetId: target.targetId, result, needsReview: true };
          }
          if (status !== "succeeded") throw new BuiltinRuntimeError("INVALID_INPUT", `${action} 未返回 completed status`);
          if (!hasDurableReference(result)) throw new BuiltinRuntimeError("INVALID_INPUT", `${action} completed result lacks durable reference`);
          return { targetKind: target.targetKind, targetId: target.targetId, result,
            needsReview: action === "generateImages" && (result as { selected?: boolean }).selected === false };
        };
        // Complete asset references before dependent storyboards; independent
        // targets share a bounded batch and retain every successful receipt.
        const batches = action === "generateImages" ? [targets.filter((target) => target.targetKind === "asset" && target.source.assetsId == null), targets.filter((target) => target.targetKind === "asset" && target.source.assetsId != null), targets.filter((target) => target.targetKind !== "asset")] : [targets];
        const failedAssetIds = new Set<number>();
        for (const batch of batches) {
          const concurrency = pLimit(2);
          const outcomes = await Promise.allSettled(batch.map((target) => concurrency(async () => {
            if (action === "generateVideos" && target.storyboardIds.some((id) => unavailableStoryboardImages.has(id))) throw new BuiltinRuntimeError("CONFLICT", "本轮分镜图未完成或未应用，已跳过对应视频，避免使用旧图片继续制作");
            if (target.targetKind === "asset" && target.source.assetsId != null && failedAssetIds.has(Number(target.source.assetsId))) throw new BuiltinRuntimeError("CONFLICT", "父素材尚不可用，本次跳过该衍生图片");
            if (target.targetKind === "storyboard" && (target.source.associateAssetsIds ?? []).some((id: number) => failedAssetIds.has(Number(id)))) throw new BuiltinRuntimeError("CONFLICT", "引用素材尚不可用，本次跳过该分镜图片");
            return performTarget(target);
          })));
          for (let index = 0; index < outcomes.length; index++) {
            const outcome = outcomes[index], target = batch[index];
            if (outcome.status === "fulfilled") {
              results.push(outcome.value);
              if (outcome.value.needsReview) issues.push({ targetKind: target.targetKind, targetId: target.targetId, message: "生成结果已保存；目标内容已变更或不可用，未覆盖当前画布。", result: outcome.value.result });
            } else {
              const error = outcome.reason;
              if (error instanceof BuiltinRuntimeError && ["LEASE_LOST", "PAUSED", "CANCELLED", "WAITING_HUMAN"].includes(error.code)) throw error;
              issues.push({ targetKind: target.targetKind, targetId: target.targetId, message: error instanceof Error ? error.message : "媒体任务失败" });
            }
            if (target.targetKind === "asset" && (outcome.status === "rejected" || outcome.value.needsReview)) failedAssetIds.add(target.targetId);
            if (action === "generateImages" && target.targetKind === "storyboard" && (outcome.status === "rejected" || outcome.value.needsReview)) unavailableStoryboardImages.add(target.targetId);
          }
        }
        output[action] = results;
        flow = await readProductionFlow(deps.db, projectId, scriptId, async (path) => path);
        knownStoryboards = new Map(flow.storyboard.map((storyboard: any) => [Number(storyboard.id), storyboard]));
        if (issues.length) {
          executionIssues.push(...issues.map((issue) => ({ action, ...issue })));
          await ctx.emit("message.completed", { text: `本步骤已结束，${issues.length} 项未应用或未完成；生成结果已保留，可直接在画布调整。其余可执行步骤继续进行。` });
        }
      } else if (action === "review") {
        const review = await model("review", "productionAgent:supervisionAgent", "builtin_production_review.md", reviewSchema, { request: requestText, project, flow, output }, budget);
        output.review = review;
        await ctx.emit("message.completed", { text: [review.summary, ...review.findings].join("\n") });
      }
    }
    if (executionIssues.length) {
      output.outcome = executionIssues.every((issue) => (issue.result as { status?: string } | undefined)?.status === "succeeded") ? "complete_with_notes" : "partial";
      output.issues = executionIssues;
    }
    return output;
  };
}

function hasDurableReference(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["jobId", "taskId", "reference", "resultUrl"].some((key) => record[key] !== undefined && record[key] !== null && record[key] !== "");
}

function mediaResultStatus(value: unknown): "succeeded" | "pending" | "needs_reconciliation" | "invalid" {
  if (!value || typeof value !== "object") return "invalid";
  const status = (value as { status?: unknown }).status;
  if (status === "succeeded" || status === "pending" || status === "needs_reconciliation") return status;
  return "invalid";
}
