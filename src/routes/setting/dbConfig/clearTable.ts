import express from "express";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import { hasUserTable } from "@/lib/dbPortable";

const router = express.Router();

export default router.post("/", async (req, res) => {
  try {
    const { tableName, confirm } = req.body;
    if (confirm !== "CLEAR_TABLE") return res.status(400).send(error("需要 confirm=CLEAR_TABLE 才能清空表"));
    if (!tableName || typeof tableName !== "string") {
      return res.status(400).send(error("请提供有效的表名"));
    }

    if (!(await hasUserTable(db, tableName))) return res.status(400).send(error("表不存在或标识符非法"));
    await db.transaction(async (trx) => { await trx(tableName).delete(); });

    res.status(200).send(success(`表 ${tableName} 已清空`));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "清空表失败"));
  }
});
