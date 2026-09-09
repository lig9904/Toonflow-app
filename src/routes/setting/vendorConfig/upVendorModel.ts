import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
import { upsertVendorModel } from "@/lib/vendorModelConfig";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.string(),
    modelName: z.string(),
    model: z.discriminatedUnion("type", [
      z.object({
        name: z.string(),
        modelName: z.string(),
        type: z.literal("text"),
        think: z.boolean(),
      }),
      z.object({
        name: z.string(),
        modelName: z.string(),
        type: z.literal("image"),
        mode: z.array(z.enum(["text", "singleImage", "multiReference"])),
      }),
      z.object({
        name: z.string(),
        modelName: z.string(),
        type: z.literal("video"),
        mode: z.array(
          z.union([
            z.enum(["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", "text", "audioReference", "videoReference"]),
            z.array(z.string().regex(/^(videoReference|imageReference|audioReference):\d+$/)),
          ]),
        ),
        audio: z.union([z.literal("optional"), z.boolean()]),
        durationResolutionMap: z.array(
          z.object({
            duration: z.array(z.number()),
            resolution: z.array(z.string()),
          }),
        ),
      }),
    ]),
  }),
  async (req, res) => {
    const { id, modelName, model } = req.body;

    const models = await u.db("o_vendorConfig").where("id", id).first("models");
    if (!models) return res.status(404).send(error("供应商不存在"));
    try {
      await u
        .db("o_vendorConfig")
        .where("id", id)
        .update({
          models: upsertVendorModel(models.models, modelName, model),
        });
    } catch (updateError) {
      return res.status(400).send(error(updateError instanceof Error ? updateError.message : "模型配置无效"));
    }
    res.status(200).send(success("更新成功"));
  },
);
