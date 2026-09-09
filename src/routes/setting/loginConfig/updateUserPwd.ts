import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { hashPassword } from "@/lib/password";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    name: z.string().min(1).max(128),
    password: z.string().min(8).max(1024),
    id: z.number().int().positive(),
  }),
  async (req, res) => {
    const { name, password, id } = req.body;
    const callerId = Number((req as any).user?.id);
    const adminId = Number(process.env.TOONFLOW_ADMIN_USER_ID || 1);
    if (!Number.isSafeInteger(callerId) || (callerId !== id && callerId !== adminId)) {
      return res.status(403).send({ message: "无权修改该账号" });
    }
    await u.db("o_user").where("id", id).update({
      name,
      password: hashPassword(password),
    });
    res.status(200).send(success("保存设置成功"));
  },
);
