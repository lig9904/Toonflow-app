import express from "express";
import { error } from "@/lib/responseFormat";

const router = express.Router();

// Import replaces the whole schema and cannot be made safe by a request-time
// SQLite toggle. Keep the old endpoint unavailable until the PG migration job
// supplies authenticated, versioned, transaction-safe restore semantics.
export default router.post("/", async (req, res) => {
  if (req.body?.confirm !== "REPLACE_DATABASE") return res.status(400).send(error("需要 confirm=REPLACE_DATABASE 才能请求导入"));
  return res.status(410).send(error("数据库导入接口在 PostgreSQL 迁移完成前已禁用"));
});
