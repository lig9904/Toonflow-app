import express, { type Request, type Response, type NextFunction } from "express";
import type { Knex } from "knex";
import {
  TeamSecurityError,
  TeamService,
  capabilitiesForRole,
  getTeamUser,
  resolveTeamSession,
  extractTeamSessionToken,
  type TeamPrincipal,
  type TeamRole,
} from "@/services/team";

export interface TeamRouterOptions {
  db: Knex;
  service?: TeamService;
  authenticate?: (req: Request) => Promise<TeamPrincipal>;
  enforceOrigin?: (req: Request) => void | Promise<void>;
}

function sendError(res: Response, error: unknown): void {
  const e = error instanceof TeamSecurityError ? error : new TeamSecurityError("TEAM_REQUEST_FAILED", "团队请求失败", 500);
  res.status(e.status).send({ code: e.code, message: e.message });
}

function bodyObject(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new TeamSecurityError("INVALID_BODY", "请求体无效", 400);
  return req.body as Record<string, unknown>;
}

async function defaultAuthenticate(db: Knex, req: Request): Promise<TeamPrincipal> {
  const token = extractTeamSessionToken(req);
  if (!token) throw new TeamSecurityError("SESSION_REQUIRED", "需要团队会话", 401);
  return resolveTeamSession(db, token);
}

function role(value: unknown): TeamRole {
  if (value === "admin" || value === "editor" || value === "viewer") return value;
  throw new TeamSecurityError("INVALID_ROLE", "角色无效", 400);
}

/** Factory keeps the database and authentication boundary injectable for tests and integration. */
export function createTeamRouter(options: TeamRouterOptions): express.Router {
  const router = express.Router();
  const service = options.service ?? new TeamService(options.db);

  const authenticated = async (req: Request): Promise<TeamPrincipal> => {
    if (options.enforceOrigin) await options.enforceOrigin(req);
    const principal = options.authenticate ? await options.authenticate(req) : await defaultAuthenticate(options.db, req);
    (req as any).teamPrincipal = principal;
    return principal;
  };

  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, _next: NextFunction) => {
    try { await fn(req, res); } catch (error) { sendError(res, error); }
  };

  router.post("/me", handle(async (req, res) => {
    const principal = await authenticated(req);
    res.status(200).send({ code: 200, data: { user: { id: principal.id, name: principal.name, role: principal.role, enabled: principal.enabled, version: principal.version }, capabilities: capabilitiesForRole(principal.role) } });
  }));

  router.post("/listUsers", handle(async (req, res) => {
    const principal = await authenticated(req);
    const users = await service.listUsers(principal.id);
    res.status(200).send({ code: 200, data: { users } });
  }));

  router.post("/createUser", handle(async (req, res) => {
    const principal = await authenticated(req);
    const input = bodyObject(req);
    const user = await service.createUser(principal.id, { name: String(input.name ?? ""), password: String(input.password ?? ""), role: role(input.role) });
    res.status(200).send({ code: 200, data: { user } });
  }));

  router.post("/updateUser", handle(async (req, res) => {
    const principal = await authenticated(req);
    const input = bodyObject(req);
    const updated = await service.updateUser(principal.id, {
      id: input.id,
      expectedVersion: Number(input.expectedVersion),
      ...(input.name !== undefined ? { name: String(input.name) } : {}),
      ...(input.role !== undefined ? { role: role(input.role) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled as boolean } : {}),
    });
    res.status(200).send({ code: 200, data: { user: updated } });
  }));

  return router;
}

export default createTeamRouter;
