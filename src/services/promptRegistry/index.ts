import type { Knex } from "knex";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isPostgres } from "@/lib/dbTransaction";
import { promptDefaults, commonPromptSeeds } from "@/lib/promptDefaults";

export interface PromptPaths { skillsDir: string; modelPromptDir: string }
export interface PromptDefinition {
  key: string; name: string; group: "common" | "video" | "skill" | "review";
  source: string; usedBy: string[]; requiredContext: string[]; requiredVariables: string[];
  file?: string; commonType?: string; defaultContent?: string;
}
const define = (key: string, name: string, group: PromptDefinition["group"], usedBy: string[], requiredContext: string[], extra: Partial<PromptDefinition> = {}): PromptDefinition => ({ key, name, group, source: group === "common" ? "o_prompt.data / o_prompt.useData" : group === "review" ? "code default / registry override" : `${group} file / registry override`, usedBy, requiredContext, requiredVariables: [], ...extra });
const videoContext = ["model", "mode", "sourceStoryboards", "referenceMapping", "scriptDuration", "generationDuration", "audioEnabled", "userRequirements"];
export const promptDefinitions: readonly PromptDefinition[] = [
  define("common.eventExtraction", "事件提取", "common", ["novelEventWorkspace.executor"], ["chapterIndex", "chapterTitle", "chapterContent", "outputSchema"], { commonType: "eventExtraction", defaultContent: promptDefaults.eventExtraction }),
  define("common.scriptAssetExtraction", "剧本资产提取", "common", ["script.extractAssets", "builtinAgent.assetExtraction"], ["script", "existingAssets", "projectStyle", "outputSchema"], { commonType: "scriptAssetExtraction", defaultContent: promptDefaults.scriptAssetExtraction }),
  define("common.videoPromptGeneration", "视频提示词共同规范", "common", ["production.workbench.generateVideoPrompt", "videoPromptJobs"], videoContext, { commonType: "videoPromptGeneration", defaultContent: promptDefaults.videoPromptGeneration }),
  define("common.audioBindPrompt", "音色绑定", "common", ["builtinAgent.audioExecutor"], ["selectedRoles", "candidateAudioFamilies", "existingBindings", "outputSchema"], { commonType: "audioBindPrompt", defaultContent: promptDefaults.audioBindPrompt }),
  define("review.videoPromptReview", "视频提示词校验与最小修正", "review", ["videoPromptJobs.review"], [...videoContext, "candidatePrompt", "outputSchema"], { defaultContent: promptDefaults.videoPromptReview }),
  define("review.generatedImageReview", "生成图片视觉核验", "review", ["generatedImageReview"], ["referenceImages", "generatedImage", "shotRequirements", "outputSchema"], { defaultContent: promptDefaults.generatedImageReview }),
  ...([
    ["text", "文生视频", "textMode.md"], ["firstFrame", "单图首帧", "firstFrameMode.md"],
    ["firstLastFrame", "首尾帧", "universalFirstAndLastFrameMode.md"], ["multiReference", "混合参考", "universalMulti-parameterMode.md"], ["seedance", "Seedance 模型差异", "seedance2Multi-parameterMode.md"], ["wan26", "Wan 2.6 模型差异", "wan2.6Single-imageFirstFrameMode.md"],
  ] as const).map(([key, name, file]) => define(`video.${key}`, name, "video", ["production.workbench.generateVideoPrompt"], videoContext, { file: `video/${file}` })),
  ...([
    ["builtin_script_decision", "剧本阶段决策"], ["builtin_script_skeleton", "故事骨架"], ["builtin_script_adaptation", "改编策略"], ["builtin_script_episodes", "分集剧本"], ["builtin_script_review", "剧本审核"],
    ["builtin_production_director", "导演计划"], ["builtin_production_storyboard", "分镜制作"], ["builtin_production_derive", "衍生素材"], ["builtin_production_review", "制作审核"],
  ] as const).map(([key, name]) => define(`skill.${key}`, name, "skill", [key.startsWith("builtin_script") ? "builtinAgent.scriptExecutor" : "builtinAgent.productionExecutor"], ["workspaceSnapshot", "realResourceIds", "userRequirements", "outputSchema"], { file: `${key}.md` })),
];
export const promptCodeContracts = [
  "输出 schema、真实 ID、资源归属、授权与额度由代码控制，正文编辑不能覆盖。",
  "有效组合为共同规范、当前模式、必要模型差异和调用方执行协议；显式模型映射可能优先，项目艺术风格由运行上下文加入。",
  "变更仅影响下一次运行；已开始的运行使用已保存快照。必要上下文由调用方注入，不要求正文使用占位符。",
];
export interface ManagedPrompt extends PromptDefinition {
  id: number | string; content: string; defaultContent: string; customized: boolean;
  version: string; updatedAt: string | null; editable: boolean; codeContracts: string[];
}
export class PromptRegistryError extends Error {
  constructor(public code: "INVALID_INPUT" | "NOT_FOUND" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "DEFAULT_UNAVAILABLE", message: string, public currentVersion?: string) { super(message); this.name = "PromptRegistryError"; }
}
const STATE = "ext_prompt_registry";
const HISTORY = "ext_prompt_history";
const REQUESTS = "ext_prompt_requests";
const ready = new WeakMap<object, Promise<void>>();
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function definition(key: string): PromptDefinition { const d = promptDefinitions.find(p => p.key === key); if (!d) throw new PromptRegistryError("NOT_FOUND", "提示词不存在"); return d; }
function parse<T>(value: unknown): T { return typeof value === "string" ? JSON.parse(value) as T : value as T; }
export async function ensurePromptRegistrySchema(db: Knex): Promise<void> {
  let pending = ready.get(db);
  if (!pending) {
    pending = db.transaction(async trx => {
      if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["toonflow:prompt-registry-schema"]);
      if (!await trx.schema.hasTable(STATE)) await trx.schema.createTable(STATE, t => { t.string("key", 128).primary(); t.text("override").nullable(); t.integer("revision").notNullable().defaultTo(0); t.string("updatedAt", 40).nullable(); });
      if (!await trx.schema.hasTable(HISTORY)) await trx.schema.createTable(HISTORY, t => { t.string("key", 128).notNullable(); t.string("version", 64).notNullable(); t.text("content").notNullable(); t.boolean("customized").notNullable(); t.string("actor", 180).notNullable(); t.string("operation", 16).notNullable(); t.string("createdAt", 40).notNullable(); t.primary(["key", "version"]); });
      if (!await trx.schema.hasTable(REQUESTS)) await trx.schema.createTable(REQUESTS, t => { t.string("key", 128).notNullable(); t.string("actor", 180).notNullable(); t.string("idempotencyKey", 150).notNullable(); t.string("requestHash", 64).notNullable(); t.text("result").notNullable(); t.primary(["key", "actor", "idempotencyKey"]); });
      if (await trx.schema.hasTable("o_prompt")) for (const seed of commonPromptSeeds) {
        const row = await trx("o_prompt").where("type", seed.type).first();
        if (row) await trx("o_prompt").where("type", seed.type).update({ data: seed.data, ...(typeof row.useData === "string" && !row.useData.trim() ? { useData: null } : {}) });
        else await trx("o_prompt").insert(seed);
      }
    });
    ready.set(db, pending); pending.catch(() => ready.delete(db));
  }
  await pending;
}
async function fileDefault(d: PromptDefinition, paths: PromptPaths): Promise<string> {
  if (!d.file) return d.defaultContent!;
  const base = d.group === "skill" ? paths.skillsDir : paths.modelPromptDir;
  try {
    const root = await fs.realpath(base); const target = await fs.realpath(path.resolve(root, d.file));
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("outside allowed root");
    const content = await fs.readFile(target, "utf8");
    if (!content.trim()) throw new Error("empty default");
    return content;
  } catch { throw new PromptRegistryError("DEFAULT_UNAVAILABLE", `提示词默认文件不可用：${d.key}`); }
}
async function readEntry(db: Knex | Knex.Transaction, key: string, paths: PromptPaths): Promise<ManagedPrompt> {
  const d = definition(key); const defaultContent = await fileDefault(d, paths);
  const state = await db(STATE).where({ key }).first();
  const legacy = d.commonType ? await db("o_prompt").where("type", d.commonType).first() : undefined;
  const override = d.commonType ? legacy?.useData : state?.override;
  const customized = typeof override === "string" && override.trim().length > 0;
  const content = customized ? override : defaultContent;
  const version = hash({ key, defaultContent, content, customized, revision: Number(state?.revision ?? 0) });
  return { ...d, id: legacy?.id ?? key, content, defaultContent, customized, version, updatedAt: state?.updatedAt ?? null, editable: true, codeContracts: [...promptCodeContracts] };
}
export async function readManagedPrompt(db: Knex, key: string, paths: PromptPaths): Promise<ManagedPrompt> { definition(key); await ensurePromptRegistrySchema(db); return readEntry(db, key, paths); }
export async function listManagedPrompts(db: Knex, paths: PromptPaths): Promise<ManagedPrompt[]> { await ensurePromptRegistrySchema(db); return Promise.all(promptDefinitions.map(d => readEntry(db, d.key, paths))); }
export async function capturePromptSnapshot(db: Knex, paths: PromptPaths): Promise<Record<string, ManagedPrompt>> {
  await ensurePromptRegistrySchema(db);
  return db.transaction(async trx => {
    if (isPostgres(trx)) await trx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const entries: ManagedPrompt[] = [];
    for (const d of promptDefinitions) entries.push(await readEntry(trx, d.key, paths));
    return Object.fromEntries(entries.map(p => [p.key, p]));
  });
}
export interface PromptWrite { expectedVersion: string; idempotencyKey: string; actor: { id: string; kind?: string }; content?: string; historyVersion?: string }
function validateWrite(input: PromptWrite, operation: string) {
  if (!input || typeof input.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedVersion)) throw new PromptRegistryError("INVALID_INPUT", "保存需要当前 expectedVersion");
  if (typeof input.idempotencyKey !== "string" || !/^[\w:.-]{8,150}$/.test(input.idempotencyKey)) throw new PromptRegistryError("INVALID_INPUT", "保存需要有效 idempotencyKey");
  if (!input.actor || typeof input.actor.id !== "string" || !input.actor.id.trim() || input.actor.id.length > 180) throw new PromptRegistryError("INVALID_INPUT", "保存需要已认证操作者");
  if (operation === "save" && (typeof input.content !== "string" || !input.content.trim() || input.content.length > 100000)) throw new PromptRegistryError("INVALID_INPUT", "提示词必须为非空文本，且不超过 100000 字符；恢复默认请使用恢复操作");
  if (operation === "restore" && (typeof input.historyVersion !== "string" || !/^[a-f0-9]{64}$/.test(input.historyVersion))) throw new PromptRegistryError("INVALID_INPUT", "历史版本无效");
}
async function history(db: Knex.Transaction, p: ManagedPrompt, actor: string, operation: string) { await db(HISTORY).insert({ key: p.key, version: p.version, content: p.content, customized: p.customized, actor, operation, createdAt: new Date().toISOString() }).onConflict(["key", "version"]).ignore(); }
async function mutate(db: Knex, key: string, input: PromptWrite, paths: PromptPaths, operation: "save" | "reset" | "restore"): Promise<ManagedPrompt> {
  const d = definition(key); validateWrite(input, operation); await ensurePromptRegistrySchema(db);
  return db.transaction(async trx => {
    await trx(STATE).insert({ key, revision: 0 }).onConflict("key").ignore();
    let lock = trx(STATE).where({ key }); if (isPostgres(trx)) lock = lock.forUpdate(); await lock.first();
    const request = { key, actor: input.actor.id, idempotencyKey: input.idempotencyKey };
    const requestHash = hash({ operation, expectedVersion: input.expectedVersion, content: input.content, historyVersion: input.historyVersion });
    const replay = await trx(REQUESTS).where(request).first();
    if (replay) { if (replay.requestHash !== requestHash) throw new PromptRegistryError("IDEMPOTENCY_CONFLICT", "同一保存请求编号已用于不同内容"); return parse<ManagedPrompt>(replay.result); }
    const current = await readEntry(trx, key, paths);
    if (current.version !== input.expectedVersion) throw new PromptRegistryError("VERSION_CONFLICT", "提示词已被更新，请读取最新版本后再保存", current.version);
    let content: string | null = operation === "save" ? input.content! : null;
    if (operation === "restore") { const old = await trx(HISTORY).where({ key, version: input.historyVersion }).first(); if (!old) throw new PromptRegistryError("NOT_FOUND", "历史版本不存在"); content = old.content; }
    if (content === current.defaultContent) content = null;
    await history(trx, current, input.actor.id, "snapshot");
    await trx(STATE).where({ key }).update({ override: d.commonType ? null : content, revision: trx.raw('?? + 1', ["revision"]), updatedAt: new Date().toISOString() });
    if (d.commonType) await trx("o_prompt").where("type", d.commonType).update({ useData: content });
    const result = await readEntry(trx, key, paths); await history(trx, result, input.actor.id, operation);
    await trx(REQUESTS).insert({ ...request, requestHash, result: JSON.stringify(result) }); return result;
  });
}
export const saveManagedPrompt = (db: Knex, key: string, input: PromptWrite & { content: string }, paths: PromptPaths) => mutate(db, key, input, paths, "save");
export const resetManagedPrompt = (db: Knex, key: string, input: PromptWrite, paths: PromptPaths) => mutate(db, key, input, paths, "reset");
export const restoreManagedPrompt = (db: Knex, key: string, input: PromptWrite & { historyVersion: string }, paths: PromptPaths) => mutate(db, key, input, paths, "restore");
export async function listPromptHistory(db: Knex, key: string, paths: PromptPaths) { const current = await readManagedPrompt(db, key, paths); const items = await db(HISTORY).where({ key }).orderBy("createdAt", "desc").limit(100); return { currentVersion: current.version, items }; }
export async function previewManagedPrompt(db: Knex, key: string, paths: PromptPaths) {
  const entry = await readManagedPrompt(db, key, paths);
  const parts = entry.group === "video" ? [await readManagedPrompt(db, "common.videoPromptGeneration", paths), entry] : [entry];
  return { key, version: entry.version, parts: parts.map(p => ({ key: p.key, version: p.version, content: p.content })), content: parts.map(p => p.content).join("\n\n"), previewKind: "managed-layers", runtimeContextRequired: entry.requiredContext, codeContracts: promptCodeContracts, note: "管理层组合预览。运行时还会加入实际模式、模型差异、显式模型映射、项目风格、资源与不可编辑的执行协议；本预览不调用模型。" };
}
