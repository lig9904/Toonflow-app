import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
const router = express.Router();

// 获取项目
export default router.post("/", async (req, res) => {
  const userId = Number((req as any).user?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(401).send({ message: "请先登录" });
  const data = await u.db("o_project").where({ userId }).select("*");
  res.status(200).send(success(data));
});
