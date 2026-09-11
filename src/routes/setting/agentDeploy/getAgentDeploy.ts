import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
const router = express.Router();

export default router.post("/", async (req, res) => {
  const allData = await u.db("o_agentDeploy").leftJoin("o_vendorConfig", "o_vendorConfig.id", "o_agentDeploy.vendorId").select("o_agentDeploy.*");
  // The model key is the runtime binding. Resolve its current catalogue name
  // instead of displaying a label cached before a provider/model migration.
  const names = new Map<string, string>();
  const vendors = [...new Set(allData.map((item) => String(item.modelName ?? "").split(/:(.+)/)[0]).filter(Boolean))];
  await Promise.all(vendors.map(async (vendorId) => {
    const models = await u.vendor.getModelList(vendorId).catch(() => []);
    for (const model of models) {
      if (typeof model.modelName === "string") names.set(`${vendorId}:${model.modelName}`, typeof model.name === "string" && model.name.trim() ? model.name : model.modelName);
    }
  }));
  const currentData = allData.map((item) => {
    const key = String(item.modelName ?? "");
    return { ...item, model: key ? names.get(key) ?? key.split(/:(.+)/)[1] ?? key : "" };
  });
  const qrdinaryData = currentData.filter((item: any) => !item.key?.includes(":"));
  const advancedData = currentData.filter((item: any) => item.key?.includes(":") || item.key == "universalAi");
  res.status(200).send(success({ qrdinaryData, advancedData }));
});
