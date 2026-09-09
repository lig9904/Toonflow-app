import express from "express";
import z from "zod";
import { error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    url: z.url(),
    reinstall: z.boolean(),
    version: z.string(),
  }),
  async (_req, res) => {
    // Managed deployments do not permit browser-triggered downloads, archive
    // extraction, or replacement of the running installation.
    res.status(409).send(error("定制版由管理员部署更新，禁止在线下载或重装"));
  },
);
