import express from "express";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import { listUserTables } from "@/lib/dbPortable";

const router = express.Router();

export default router.get("/", async (req, res) => {
  try {
    const tableInfo = [];
    for (const tableName of await listUserTables(db)) {
      const countResult = await db(tableName).count<{ count: string | number }>("* as count").first();
      tableInfo.push({
        name: tableName,
        rowCount: Number(countResult?.count ?? 0),
      });
    }

    res.status(200).send(success(tableInfo));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "获取数据库信息失败"));
  }
});
