import express from "express";
import { error } from "@/lib/responseFormat";

const router = express.Router();

// Whole-database destruction is intentionally disabled during the SQLite to
// PostgreSQL migration. It must be implemented as an authenticated maintenance
// job with an explicit confirmation and migration-aware transaction semantics.
export default router.post("/", async (req, res) => {
  if (req.body?.confirm !== "CLEAR_DATABASE") return res.status(400).send(error("需要 confirm=CLEAR_DATABASE 才能请求清库"));
  return res.status(410).send(error("清库接口在 PostgreSQL 迁移完成前已禁用"));
});
