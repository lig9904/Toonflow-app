import express from "express";
import u from "@/utils";
import { createApplicationSessionHandlers, applicationAllowedOrigins } from "@/services/applicationSession";

const handlers = createApplicationSessionHandlers({
  db: u.db,
  secureCookies: process.env.NODE_ENV === "prod",
  allowedOrigins: applicationAllowedOrigins(),
  legacySigningKey: async () => String((await u.db("o_setting").where({ key: "tokenKey" }).first())?.value ?? ""),
});
export default express.Router().post("/", handlers.login);
