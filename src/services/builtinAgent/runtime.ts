import u from "../../utils";
import { BuiltinAgentRuntime, BuiltinRuntimeError } from "../builtinAgentRuntime";
import { requireProjectAccess, requireTeamRole } from "../team";
import { createScriptAgentExecutor } from "./scriptExecutor";
import { configuredScriptModel, loadBuiltinSkill, builtinVisualStyleGuide, builtinDirectorGuide } from "./model";
import type { BuiltinRunView } from "./contracts";
import { createProductionAgentExecutor } from "./productionExecutor";
import { createProductionMediaCapabilities, defaultVideoSettings } from "./media";
import { getConfiguredMediaModel, getPersistentVideoTaskProvider, resolveConfiguredImageModel } from "../../utils/ai";
import { getProductionImageGenerationService } from "../productionImageJobRuntime";
import { getRuntimeVideoJobService } from "../videoJobs/runtime";
import type { Knex } from "knex";
import { configureAudioMatchRunStarter } from "../roleAudioWorkspace";
import { createAudioMatchExecutor, initializeAudioMatchRun } from "./audioExecutor";
import { configureNovelEventRunStarter, initializeNovelEventRun } from "../novelEventWorkspace";
import { createNovelEventExecutor } from "../novelEventWorkspace/executor";

let singleton: BuiltinAgentRuntime | undefined;

export async function authorizeBuiltinProject(userId: number, projectId: number, action: "read" | "edit", scriptId?: number | null): Promise<void> {
  await requireProjectAccess(u.db, userId, projectId, action);
  if (scriptId != null && !(await u.db("o_script").where({ id: scriptId, projectId }).first())) throw new BuiltinRuntimeError("FORBIDDEN", "剧集不属于此项目");
}

async function authorizeRun(run: BuiltinRunView, transaction?: Knex.Transaction): Promise<void> {
  const actorId = run.executionUserId ?? run.requestedBy;
  const db = transaction ?? u.db;
  if (transaction) await transaction("team_users").where({ user_id: actorId }).forUpdate().first();
  if (run.projectId == null) {
    await requireTeamRole(db, actorId, ["admin", "editor"]);
    return;
  }
  await requireProjectAccess(db, actorId, run.projectId, "edit");
  if (run.scriptId != null && !(await db("o_script").where({ id: run.scriptId, projectId: run.projectId }).first())) throw new BuiltinRuntimeError("FORBIDDEN", "剧集不属于此项目");
}

export function getBuiltinAgentRuntime(): BuiltinAgentRuntime {
  if (!singleton) {
    const script = createScriptAgentExecutor({ db: u.db, model: configuredScriptModel, loadSkill: loadBuiltinSkill, directorGuide: builtinDirectorGuide });
    const audio = createAudioMatchExecutor({ db: u.db, model: configuredScriptModel });
    const novelEvents = createNovelEventExecutor({ db: u.db, model: configuredScriptModel, fallbackPrompt: async () => String(await u.getPrompts("event") ?? "") });
    const production = createProductionAgentExecutor({ db: u.db, model: configuredScriptModel, loadSkill: loadBuiltinSkill,
      visualStyleGuide: builtinVisualStyleGuide, directorGuide: builtinDirectorGuide,
      videoModelMetadata: async (key) => defaultVideoSettings(await getConfiguredMediaModel(key, "video")),
      media: createProductionMediaCapabilities({ db: u.db, images: getProductionImageGenerationService(), videos: getRuntimeVideoJobService(),
        visualStyleGuide: builtinVisualStyleGuide, mediaRootDir: u.getPath("oss"),
        imageModelFor: resolveConfiguredImageModel, modelFor: getConfiguredMediaModel, videoProviderFor: (key) => getPersistentVideoTaskProvider(key as `${string}:${string}`), toBase64: (path) => u.oss.getImageBase64(path) }),
    });
    singleton = new BuiltinAgentRuntime({
      db: u.db,
      authorize: authorizeRun,
      beforeCreate: async (run, trx) => {
        const intent = run.intent as { phase?: string; context?: any };
        if (intent?.phase === "matchAudio") await initializeAudioMatchRun(trx, intent.context);
        if (intent?.phase === "novelEvents") await initializeNovelEventRun(trx, intent.context);
      },
      execute: async (ctx) => {
        try {
          if ((ctx.run.intent as { phase?: string })?.phase === "matchAudio") return await audio(ctx);
          if ((ctx.run.intent as { phase?: string })?.phase === "novelEvents") return await novelEvents(ctx);
          return await (ctx.run.agentType === "scriptAgent" ? script(ctx) : production(ctx));
        } catch (error) {
          const conflict = error as { code?: string; status?: number; message?: string };
          if (["VERSION_CONFLICT", "STALE_VERSION", "CONFLICT", "LOCKED"].includes(conflict?.code ?? "") || [409, 423].includes(conflict?.status ?? 0)) {
            await ctx.waitForHuman("内容已被人工修改或锁定，请确认要继续处理的范围", { code: conflict.code, message: conflict.message });
          }
          throw error;
        }
      },
    });
    configureAudioMatchRunStarter(async ({ requestedBy, idempotencyKey, context }) => {
      const result = await singleton!.create({ agentType: "productionAgent", projectId: context.projectId, scriptId: null, requestedBy,
        idempotencyKey: `audio:${idempotencyKey}`, prompt: `为选定的 ${context.roles.length} 个角色匹配已有音色`, intent: { phase: "matchAudio", context },
        limits: { maxModelCalls: 2, maxToolSteps: 12, maxOutputTokens: Math.min(64_000, Math.max(2048, context.roles.length * 128)), maxImageGenerations: 0, maxVideoGenerations: 0 } });
      return { run: { ...result.run }, reused: result.reused };
    }, async (userId, key) => {
      const run = await singleton!.findByIdempotency(userId, `audio:${key}`);
      return run ? { run: { ...run }, reused: true } : undefined;
    });
    configureNovelEventRunStarter(async ({ requestedBy, idempotencyKey, context, limits }) => {
      const result = await singleton!.create({ agentType: "scriptAgent", projectId: context.projectId, scriptId: null, requestedBy,
        idempotencyKey: `novel-events:${idempotencyKey}`, prompt: `为选定的 ${context.chapters.length} 个原文章节提取事件`, intent: { phase: "novelEvents", context }, limits });
      return { run: { ...result.run }, reused: result.reused };
    }, async (userId, key) => {
      const run = await singleton!.findByIdempotency(userId, `novel-events:${key}`);
      return run ? { run: { ...run }, reused: true } : undefined;
    });
  }
  return singleton;
}
