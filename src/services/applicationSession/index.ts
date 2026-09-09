import type { Knex } from "knex";
import express, { type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { hashLegacyPassword, hashPassword, isPasswordHash, verifyPassword } from "../../lib/password";
import {
  assertRequestOrigin, extractTeamSessionToken, getTeamUser, issueTeamSession,
  revokeTeamSession, revokeTeamUserSessions, setTeamSessionCookie, TEAM_SESSION_COOKIE,
  TeamSecurityError, type TeamPrincipal,
} from "../team";

export interface ApplicationSessionOptions {
  db: Knex;
  secureCookies: boolean;
  allowedOrigins?: string[];
  legacySigningKey(): Promise<string>;
}

export function applicationAllowedOrigins(): string[] {
  return (process.env.TOONFLOW_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid configured application origin");
    return url.origin;
  });
}

function failure(res: Response, error: unknown): Response {
  if (error instanceof z.ZodError) return res.status(400).send({ code: "INVALID_INPUT", message: "账号参数格式错误" });
  if (error instanceof TeamSecurityError) return res.status(error.status).send({ code: error.code, message: error.message });
  return res.status(500).send({ code: "SESSION_ERROR", message: "会话操作失败" });
}

const publicUser = (user: { id: number; name: string; role: string }) => ({ authenticated: true, id: user.id, name: user.name, role: user.role });
function clearCookie(res: Response, secure: boolean): void {
  res.setHeader("Set-Cookie", `${TEAM_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
}

export function createApplicationSessionHandlers(options: ApplicationSessionOptions) {
  const login = async (req: Request, res: Response) => {
    try {
      assertRequestOrigin(req, options.allowedOrigins);
      const data = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(1024) }).strict().parse(req.body);
      const session = await options.db.transaction(async (trx) => {
        const user = await trx("o_user").where({ name: data.username }).forUpdate().first();
        if (!user || !verifyPassword(data.password, user.password)) throw new TeamSecurityError("LOGIN_FAILED", "用户名或密码错误", 401);
        await getTeamUser(trx, Number(user.id));
        if (!isPasswordHash(user.password)) await trx("o_user").where({ id: user.id }).update({ password: hashLegacyPassword(user.password) });
        return issueTeamSession(trx, Number(user.id), { secureCookie: options.secureCookies });
      });
      res.setHeader("Cache-Control", "no-store");
      setTeamSessionCookie(res, session);
      return res.send({ code: 200, data: publicUser(session.user), message: "登录成功" });
    } catch (error) { return failure(res, error); }
  };

  const exchange = async (req: Request, res: Response) => {
    try {
      assertRequestOrigin(req, options.allowedOrigins);
      const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? "");
      if (!match) throw new TeamSecurityError("SESSION_REQUIRED", "请重新登录", 401);
      let decoded: jwt.JwtPayload;
      try {
        const value = jwt.verify(match[1], await options.legacySigningKey(), { algorithms: ["HS256"] });
        if (typeof value !== "object") throw new Error("Invalid legacy payload");
        decoded = value;
      } catch { throw new TeamSecurityError("SESSION_INVALID", "旧会话已过期，请重新登录", 401); }
      const id = Number(decoded.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new TeamSecurityError("SESSION_INVALID", "请重新登录", 401);
      const session = await options.db.transaction(async (trx) => {
        await trx("team_users").where({ user_id: id }).forUpdate().first();
        const user = await getTeamUser(trx, id);
        // The revision check and issue share the revocation lock. A concurrent
        // password/role change cannot turn an old JWT into a new valid session.
        if (user.sessionRevision !== 0) throw new TeamSecurityError("SESSION_REVOKED", "账号权限已变化，请重新登录", 401);
        return issueTeamSession(trx, id, { secureCookie: options.secureCookies });
      });
      res.setHeader("Cache-Control", "no-store");
      setTeamSessionCookie(res, session);
      return res.send({ code: 200, data: publicUser(session.user) });
    } catch (error) { return failure(res, error); }
  };

  const logout = async (req: Request, res: Response) => {
    try {
      assertRequestOrigin(req, options.allowedOrigins);
      const token = extractTeamSessionToken(req);
      if (token) await revokeTeamSession(options.db, token);
      clearCookie(res, options.secureCookies);
      return res.send({ code: 200, data: { authenticated: false } });
    } catch (error) { return failure(res, error); }
  };
  return { login, exchange, logout };
}

export function createApplicationSessionRouter(options: ApplicationSessionOptions): express.Router {
  const router = express.Router();
  const handlers = createApplicationSessionHandlers(options);
  router.post("/exchange", handlers.exchange);
  router.post("/logout", handlers.logout);
  return router;
}

export async function updateAccountPassword(db: Knex, principal: TeamPrincipal, input: { id: number; name: string; password: string }): Promise<void> {
  const data = z.object({ id: z.number().int().positive(), name: z.string().trim().min(1).max(128), password: z.string().min(8).max(1024) }).strict().parse(input);
  if (principal.id !== data.id && principal.role !== "admin") throw new TeamSecurityError("ACCOUNT_FORBIDDEN", "无权修改此账号", 403);
  await getTeamUser(db, principal.id);
  await db.transaction(async (trx) => {
    const user = await trx("o_user").where({ id: data.id }).forUpdate().first();
    if (!user) throw new TeamSecurityError("USER_NOT_FOUND", "账号不存在", 404);
    const duplicate = await trx("o_user").where({ name: data.name }).whereNot({ id: data.id }).first();
    if (duplicate) throw new TeamSecurityError("USER_EXISTS", "用户名已存在", 409);
    await trx("o_user").where({ id: data.id }).update({ name: data.name, password: hashPassword(data.password) });
    await revokeTeamUserSessions(trx, data.id);
  });
}
