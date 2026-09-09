import express from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { managedUpdatePayload } from "@/lib/customUpdatePolicy";

const router = express.Router();
declare const __APP_VERSION__: string | undefined;

const APP_VERSION: string = (() => {
  if (typeof __APP_VERSION__ !== "undefined") return __APP_VERSION__;
  const packagePath = path.resolve(process.cwd(), "package.json");
  return JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
})();

export default router.post(
  "/",
  validateFields({
    source: z.enum(["toonflow", "github", "gitee", "atomgit"]),
    url: z.url().nullable().optional(),
  }),
  async (_req, res) => {
    // Managed deployments never contact the upstream/custom source and never
    // return a download URL. Releases are built and installed by the operator.
    res.status(200).send(success(managedUpdatePayload(APP_VERSION)));
  },
);
