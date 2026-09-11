import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { previewManagedPrompt, PromptRegistryError } from "@/services/promptRegistry";
import { composeVideoPrompt } from "@/services/videoPromptComposition";
import { getConfiguredMediaModel } from "@/utils/ai";
import { promptPaths, promptKey, sendPromptError, promptActor } from "./_shared";
const compiledInput = z.object({ model: z.string().min(1), mode: z.union([z.string().min(1), z.array(z.string())]), referenceCount: z.number().int().nonnegative(), scriptDuration: z.number().finite().positive(),
  generation: z.object({ duration: z.number().finite().positive().optional(), resolution: z.string().min(1).optional(), audio: z.boolean().optional() }).optional(), projectId: z.number().int().positive().optional() });
export default express.Router().post("/", async (req, res) => {
  try {
    if (req.body?.model !== undefined) {
      promptActor(req); // The settings middleware additionally requires administrator scope.
      const parsed = compiledInput.safeParse(req.body);
      if (!parsed.success) throw new PromptRegistryError("INVALID_INPUT", "组合预览需要有效模型、模式、参考数量和脚本时长");
      const input = parsed.data;
      const project = input.projectId ? await u.db("o_project").where({ id: input.projectId }).select("artStyle").first() : null;
      if (input.projectId && !project) throw new PromptRegistryError("NOT_FOUND", "预览项目不存在");
      try {
        const composition = await composeVideoPrompt(u.db, { ...input, capabilities: await getConfiguredMediaModel(input.model, "video"), visualManual: project ? u.getArtPrompt(project.artStyle || "无", "art_skills", "art_storyboard_video") : "" }, promptPaths());
        return res.send(success({ previewKind: "compiled-video-prompt", ...composition, notice: "这是按当前模型和参数编译的规则预览；未载入当前轨道源分镜和真实参考正文，不是已发送的模型请求，也不会调用生成模型。" }));
      } catch (error) {
        if (error instanceof PromptRegistryError) throw error;
        // Configuration errors are reviewable input failures, without exposing paths or credentials.
        throw new PromptRegistryError("INVALID_INPUT", "当前模型、模板映射或生成参数无法组合，请检查已配置的能力与模板");
      }
    }
    return res.send(success(await previewManagedPrompt(u.db, await promptKey(req), promptPaths())));
  } catch (err) { return sendPromptError(res, err); }
});
