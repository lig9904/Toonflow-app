import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readRoleAudioBindings } from "@/services/roleAudioWorkspace";
import { sendRoleAudioError } from "@/services/roleAudioWorkspace/http";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    ids: z.array(z.number()),
    projectId: z.number(),
    runId: z.string().uuid(),
  }),
  async (req, res) => {
    try {
      const { ids, projectId, runId } = req.body;
      const run = await u.db("ext_builtin_runs").where({ id: runId, projectId }).select("id", "idempotencyKey", "agentType", "scriptId", "status", "intent", "errorMessage").first();
      const intent = typeof run?.intent === "string" ? JSON.parse(run.intent) : run?.intent;
      const requestedRoleIds = Array.isArray(intent?.context?.roles) ? intent.context.roles.map((role: any) => Number(role.id)).sort((a: number, b: number) => a - b) : [];
      const polledIds: number[] = [...new Set<number>((ids as unknown[]).map((value) => Number(value)))].sort((a, b) => a - b);
      if (!run || !String(run.idempotencyKey).startsWith("audio:") || run.agentType !== "productionAgent" || run.scriptId != null || intent?.phase !== "matchAudio" || Number(intent?.context?.projectId) !== projectId || JSON.stringify(requestedRoleIds) !== JSON.stringify(polledIds)) {
        return res.status(403).send({ code: "PROJECT_MISMATCH", message: "音色匹配运行与角色范围不一致" });
      }
      const bindings = await readRoleAudioBindings(u.db, projectId, polledIds);
      const state = ["queued", "running"].includes(run.status)
        ? "生成中"
        : run.status === "succeeded"
          ? "已完成"
          : ["paused", "waiting_human"].includes(run.status)
            ? "待人工处理"
            : "生成失败";
      return res.status(200).send(success(bindings.map((binding) => ({ id: binding.roleAssetId, version: binding.version, relepedAudio: binding.audioFamilies, audioBindState: state, errorReason: run.errorMessage ?? "" }))));
    } catch (error) { return sendRoleAudioError(res, error); }
  },
);
