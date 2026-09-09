import express from "express";
import { success, error } from "@/lib/responseFormat";
import { db } from "@/utils/db";
import { listUserTables } from "@/lib/dbPortable";

const router = express.Router();

export default router.get("/", async (req, res) => {
  try {
    const data: Record<string, any[]> = {};
    for (const tableName of await listUserTables(db)) data[tableName] = await db(tableName).select("*");

    const exportData = {
      exportTime: Date.now(),
      tables: data,
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename=toonflow-backup-${Date.now()}.json`);
    res.status(200).send(JSON.stringify(exportData, null, 2));
  } catch (err: any) {
    res.status(500).send(error(err?.message || "导出失败"));
  }
});
