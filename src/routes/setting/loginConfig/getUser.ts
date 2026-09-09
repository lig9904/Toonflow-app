import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
const router = express.Router();

export default router.get("/", async (req, res) => {
  const callerId = Number((req as any).user?.id);
  if (!Number.isSafeInteger(callerId) || callerId <= 0) return res.status(401).send({ message: "请先登录" });
  const data = await u.db("o_user").where({ id: callerId }).select("id", "name").first();
  res.status(200).send(success(data));
});
