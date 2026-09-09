import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { parseCustomModels, sortVendorConfigRows } from "@/lib/vendorModelConfig";
const router = express.Router();

export default router.post("/", async (req, res) => {
  const data = sortVendorConfigRows(await u.db("o_vendorConfig").select("*"));

  const list = (
    await Promise.all(
      data.map(async (item) => {
        let vendor: any;
        try { vendor = u.vendor.getVendor(item.id!); } catch { vendor = undefined; }
        const customModels = parseCustomModels(item.models);
        if (!vendor) {
          return {
            ...item,
            inputValues: JSON.parse(item.inputValues ?? "{}"),
            models: customModels,
            code: u.vendor.getCode(item.id!),
            description: "",
            inputs: [],
            author: "",
            name: item.id,
            version: "1.0",
          };
        }
        return {
          ...item,
          inputValues: JSON.parse(item.inputValues ?? "{}"),
          models: await u.vendor.getModelList(item.id!),
          code: u.vendor.getCode(item.id!),
          description: vendor.description ?? "",
          inputs: vendor.inputs,
          author: vendor.author,
          name: vendor.name,
          version: vendor.version ?? "1.0",
        };
      }),
    )
  ).filter((i) => Boolean(i));

  res.status(200).send(success(list));
});
