import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Knex } from "knex";
import { hashPassword } from "@/lib/password";

export type TeamRole = "admin" | "editor" | "viewer";
export type ProjectAction = "read" | "edit" | "review" | "delete";

export interface TeamUserView {
  id: number;
  name: string;
  role: TeamRole;
  enabled: boolean;
  version: number;
}

export interface TeamPrincipal extends TeamUserView {
  sessionId?: string;
  sessionRevision: number;
}

export interface LegacyOwnerPrincipal {
  id: number;
  name: string;
  role: "legacy-owner";
  enabled: true;
  version: 1;
  sessionRevision: 0;
}

export type ProjectAccessPrincipal = TeamPrincipal | LegacyOwnerPrincipal;

export interface TeamCapabilities {
  manageMembers: boolean;
  edit: boolean;
  review: boolean;
}

export class TeamSecurityError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 403) {
    super(message);
    this.name = "TeamSecurityError";
    this.code = code;
    this.status = status;
  }
}

const TEAM_USERS = "team_users";
const TEAM_SESSIONS = "team_sessions";
const TEAM_PROJECTS = "team_projects";
const SHARED_TEAM_KEY = "shared";
const TEAM_ADMIN_INVARIANT_LOCK = 8_425_117_304_991;
export const TEAM_SESSION_COOKIE = "toonflow_session";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ROLE_SET = new Set<TeamRole>(["admin", "editor", "viewer"]);
const ACTION_SET = new Set<ProjectAction>(["read", "edit", "review", "delete"]);

type Db = Knex;
type AnyDb = any;

function asDb(db: Db): AnyDb {
  return db as AnyDb;
}

function userId(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "bigint" && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  throw new TeamSecurityError("INVALID_ID", "用户或项目 ID 无效", 400);
}

function projectId(value: unknown): number {
  return userId(value);
}

function asRole(value: unknown): TeamRole {
  if (typeof value === "string" && ROLE_SET.has(value as TeamRole)) return value as TeamRole;
  throw new TeamSecurityError("INVALID_ROLE", "角色无效", 400);
}

function nowDate(now?: Date | number): Date {
  return now instanceof Date ? new Date(now.getTime()) : new Date(now ?? Date.now());
}

function viewFromRow(row: any): TeamUserView {
  const id = userId(row.id ?? row.user_id);
  const role = asRole(row.role);
  return {
    id,
    name: String(row.name ?? `user-${id}`),
    role,
    enabled: row.enabled === true || row.enabled === 1 || row.enabled === "t",
    version: Number(row.version ?? 1),
  };
}

function principalFromRow(row: any): TeamPrincipal {
  const view = viewFromRow(row);
  return { ...view, sessionRevision: Number(row.session_revision ?? 0), sessionId: row.session_id ?? undefined };
}

async function hasTable(db: Db, table: string): Promise<boolean> {
  return asDb(db).schema.hasTable(table);
}

export interface EnsureTeamSchemaOptions { bootstrapAdminUserId?: unknown; }

/** Additive team schema. It never rebuilds or rewrites o_user/o_project. */
export async function ensureTeamSchema(db: Db, options: EnsureTeamSchemaOptions = {}): Promise<void> {
  const knex = asDb(db);
  const usersTableExisted = await hasTable(db, TEAM_USERS);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS "${TEAM_USERS}" (
      "user_id" bigint PRIMARY KEY,
      "role" text NOT NULL DEFAULT 'editor' CHECK ("role" IN ('admin','editor','viewer')),
      "enabled" boolean NOT NULL DEFAULT true,
      "version" integer NOT NULL DEFAULT 1 CHECK ("version" > 0),
      "session_revision" integer NOT NULL DEFAULT 0 CHECK ("session_revision" >= 0),
      "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS "${TEAM_SESSIONS}" (
      "id" uuid PRIMARY KEY,
      "token_hash" text NOT NULL UNIQUE,
      "user_id" bigint NOT NULL,
      "session_revision" integer NOT NULL,
      "expires_at" timestamptz NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "revoked_at" timestamptz NULL
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS "team_sessions_user_idx" ON "${TEAM_SESSIONS}" ("user_id")`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS "team_sessions_expiry_idx" ON "${TEAM_SESSIONS}" ("expires_at")`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS "${TEAM_PROJECTS}" (
      "project_id" bigint PRIMARY KEY,
      "team_key" text NOT NULL CHECK (length("team_key") > 0),
      "associated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  if (!(await hasTable(db, "o_user"))) return;
  const legacyUsers = await knex("o_user").select("id", "name").orderBy("id", "asc");
  const bootstrapAdminId = options.bootstrapAdminUserId === undefined ? undefined : userId(options.bootstrapAdminUserId);
  for (const legacy of legacyUsers) {
    const id = userId(legacy.id);
    const existing = await knex(TEAM_USERS).where({ user_id: id }).first();
    if (existing) continue;
    const isSeedAdmin = !usersTableExisted && bootstrapAdminId === id;
    await knex(TEAM_USERS).insert({ user_id: id, role: isSeedAdmin ? "admin" : "editor", enabled: true, version: 1, session_revision: 0 });
  }

  const enabledAdmin = await knex(TEAM_USERS).where({ role: "admin", enabled: true }).first();
  if (!enabledAdmin && legacyUsers.length > 0) throw new TeamSecurityError("ADMIN_REQUIRED", "团队缺少显式配置的启用管理员", 500);

  if (await hasTable(db, "o_project")) {
    await knex.raw(`
      INSERT INTO "${TEAM_PROJECTS}" ("project_id", "team_key")
      SELECT p."id", ? FROM "o_project" p
      JOIN "${TEAM_USERS}" u ON u."user_id" = p."userId"
      ON CONFLICT ("project_id") DO NOTHING
    `, [SHARED_TEAM_KEY]);
    await knex.raw(`
      CREATE OR REPLACE FUNCTION "team_associate_project_owner"() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "${TEAM_USERS}" WHERE "user_id" = NEW."userId") THEN
          INSERT INTO "${TEAM_PROJECTS}" ("project_id", "team_key") VALUES (NEW."id", '${SHARED_TEAM_KEY}')
          ON CONFLICT ("project_id") DO NOTHING;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await knex.raw(`DROP TRIGGER IF EXISTS "team_associate_project_owner_trigger" ON "o_project"`);
    await knex.raw(`CREATE TRIGGER "team_associate_project_owner_trigger" AFTER INSERT ON "o_project" FOR EACH ROW EXECUTE FUNCTION "team_associate_project_owner"()`);
  }
}

async function assertTeamSchema(db: Db): Promise<void> {
  if (!(await hasTable(db, TEAM_USERS))) throw new TeamSecurityError("TEAM_SCHEMA_REQUIRED", "团队安全架构尚未初始化", 503);
}

export async function getTeamUser(db: Db, id: unknown): Promise<TeamPrincipal> {
  await assertTeamSchema(db);
  const value = userId(id);
  const row = await asDb(db)(TEAM_USERS)
    .leftJoin("o_user", "o_user.id", "=", `${TEAM_USERS}.user_id`)
    .where(`${TEAM_USERS}.user_id`, value)
    .select(`${TEAM_USERS}.user_id as id`, "o_user.name", `${TEAM_USERS}.role`, `${TEAM_USERS}.enabled`, `${TEAM_USERS}.version`, `${TEAM_USERS}.session_revision`)
    .first();
  if (!row) throw new TeamSecurityError("USER_NOT_FOUND", "团队成员不存在", 404);
  const principal = principalFromRow(row);
  if (!principal.enabled) throw new TeamSecurityError("USER_DISABLED", "团队成员已禁用", 403);
  return principal;
}

export async function requireTeamRole(db: Db, id: unknown, roles: TeamRole | readonly TeamRole[]): Promise<TeamPrincipal> {
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.length || allowed.some((role) => !ROLE_SET.has(role))) throw new TeamSecurityError("INVALID_ROLE", "角色无效", 400);
  const principal = await getTeamUser(db, id);
  if (!allowed.includes(principal.role)) throw new TeamSecurityError("ROLE_FORBIDDEN", "当前角色无权执行此操作", 403);
  return principal;
}

function actionAllowed(role: TeamRole, action: ProjectAction, isOwner: boolean): boolean {
  if (role === "admin") return true;
  if (role === "editor") return action === "read" || action === "edit" || (action === "review" && isOwner);
  return action === "read";
}

/**
 * All enabled members share explicitly associated projects. The retained owner
 * column grants an editor the review exception; deletion remains administrative.
 */
export async function requireProjectAccess(db: Db, id: unknown, project: unknown, action: ProjectAction): Promise<ProjectAccessPrincipal> {
  if (!ACTION_SET.has(action)) throw new TeamSecurityError("UNKNOWN_OPERATION", "未知项目操作", 403);
  const actorId = userId(id);
  const pid = projectId(project);
  const teamExists = await hasTable(db, TEAM_USERS);
  if (!teamExists) {
    const owner = await asDb(db)("o_project").where({ id: pid, userId: actorId }).first();
    if (!owner) throw new TeamSecurityError("PROJECT_FORBIDDEN", "项目不存在或无权访问", 403);
    return { id: actorId, name: `legacy-${actorId}`, role: "legacy-owner", enabled: true, version: 1, sessionRevision: 0 };
  }

  const principal = await getTeamUser(db, actorId);
  const row = await asDb(db)("o_project")
    .join(TEAM_PROJECTS, `${TEAM_PROJECTS}.project_id`, "=", "o_project.id")
    .where("o_project.id", pid)
    .where(`${TEAM_PROJECTS}.team_key`, SHARED_TEAM_KEY)
    .select("o_project.id", "o_project.userId")
    .first();
  if (!row) throw new TeamSecurityError("PROJECT_NOT_FOUND", "项目不存在", 404);
  if (!actionAllowed(principal.role, action, Number(row.userId) === actorId)) throw new TeamSecurityError("PROJECT_ACTION_FORBIDDEN", "当前角色无权执行此项目操作", 403);
  return principal;
}

export function capabilitiesForRole(role: TeamRole): TeamCapabilities {
  return {
    manageMembers: role === "admin",
    edit: role === "admin" || role === "editor",
    review: role === "admin",
  };
}

export interface CreateTeamUserInput { name: string; password: string; role: TeamRole; }
export interface UpdateTeamUserInput { id: unknown; expectedVersion: number; name?: string; role?: TeamRole; enabled?: boolean; }

export class TeamService {
  constructor(readonly db: Db) {}

  async ensure(): Promise<void> { await ensureTeamSchema(this.db); }

  async me(id: unknown): Promise<{ user: TeamUserView; capabilities: TeamCapabilities }> {
    const user = await getTeamUser(this.db, id);
    const view: TeamUserView = { id: user.id, name: user.name, role: user.role, enabled: user.enabled, version: user.version };
    return { user: view, capabilities: capabilitiesForRole(user.role) };
  }

  async listUsers(actorId: unknown): Promise<TeamUserView[]> {
    await requireTeamRole(this.db, actorId, "admin");
    const rows = await asDb(this.db)(TEAM_USERS).leftJoin("o_user", "o_user.id", "=", `${TEAM_USERS}.user_id`)
      .select(`${TEAM_USERS}.user_id as id`, "o_user.name", `${TEAM_USERS}.role`, `${TEAM_USERS}.enabled`, `${TEAM_USERS}.version`)
      .orderBy(`${TEAM_USERS}.user_id`, "asc");
    return rows.map(viewFromRow);
  }

  async createUser(actorId: unknown, input: CreateTeamUserInput): Promise<TeamUserView> {
    await requireTeamRole(this.db, actorId, "admin");
    if (!input || typeof input.name !== "string" || !/\S/.test(input.name) || input.name.length > 128) throw new TeamSecurityError("INVALID_USER", "用户名无效", 400);
    const role = asRole(input.role);
    const password = hashPassword(input.password);
    return this.db.transaction(async (trx) => {
      const tx = asDb(trx);
      await tx.raw("SELECT pg_advisory_xact_lock(?)", [TEAM_ADMIN_INVARIANT_LOCK]);
      await requireTeamRole(trx, actorId, "admin");
      const duplicate = await tx("o_user").where({ name: input.name.trim() }).first();
      if (duplicate) throw new TeamSecurityError("USER_EXISTS", "用户名已存在", 409);
      const inserted = await tx("o_user").insert({ name: input.name.trim(), password }).returning("id");
      const id = userId(inserted[0]?.id ?? inserted[0]);
      await tx(TEAM_USERS).insert({ user_id: id, role, enabled: true, version: 1, session_revision: 0 });
      return { id, name: input.name.trim(), role, enabled: true, version: 1 };
    });
  }

  async updateUser(actorId: unknown, input: UpdateTeamUserInput): Promise<TeamUserView> {
    await requireTeamRole(this.db, actorId, "admin");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new TeamSecurityError("INVALID_VERSION", "版本无效", 400);
    const targetId = userId(input.id);
    if (input.role !== undefined) asRole(input.role);
    if (input.name !== undefined && (typeof input.name !== "string" || !/\S/.test(input.name) || input.name.length > 128)) throw new TeamSecurityError("INVALID_USER", "用户名无效", 400);
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new TeamSecurityError("INVALID_ENABLED", "enabled 必须为布尔值", 400);
    return this.db.transaction(async (trx) => {
      const tx = asDb(trx);
      await tx.raw("SELECT pg_advisory_xact_lock(?)", [TEAM_ADMIN_INVARIANT_LOCK]);
      await requireTeamRole(trx, actorId, "admin");
      const current = await tx(TEAM_USERS).where({ user_id: targetId }).forUpdate().first();
      if (!current) throw new TeamSecurityError("USER_NOT_FOUND", "团队成员不存在", 404);
      if (Number(current.version) !== input.expectedVersion) throw new TeamSecurityError("STALE_VERSION", "成员版本已变化", 409);
      const nextRole = input.role ?? current.role;
      const nextEnabled = input.enabled ?? Boolean(current.enabled);
      if (current.role === "admin" && current.enabled && (nextRole !== "admin" || !nextEnabled)) {
        const other = await tx(TEAM_USERS).where({ role: "admin", enabled: true }).whereNot({ user_id: targetId }).count("user_id as count").first();
        if (Number(other?.count ?? 0) < 1) throw new TeamSecurityError("LAST_ADMIN", "不能移除最后一个启用的管理员", 409);
      }
      if (input.name !== undefined) {
        const duplicate = await tx("o_user").where({ name: input.name.trim() }).whereNot({ id: targetId }).first();
        if (duplicate) throw new TeamSecurityError("USER_EXISTS", "用户名已存在", 409);
        await tx("o_user").where({ id: targetId }).update({ name: input.name.trim() });
      }
      await tx(TEAM_USERS).where({ user_id: targetId }).update({
        ...(input.role !== undefined ? { role: nextRole } : {}),
        ...(input.enabled !== undefined ? { enabled: nextEnabled } : {}),
        version: input.expectedVersion + 1,
        session_revision: Number(current.session_revision ?? 0) + 1,
        updated_at: tx.fn.now(),
      });
      const row = await tx(TEAM_USERS).leftJoin("o_user", "o_user.id", "=", `${TEAM_USERS}.user_id`)
        .where(`${TEAM_USERS}.user_id`, targetId)
        .select(`${TEAM_USERS}.user_id as id`, "o_user.name", `${TEAM_USERS}.role`, `${TEAM_USERS}.enabled`, `${TEAM_USERS}.version`).first();
      return viewFromRow(row);
    });
  }
}

function digestToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export interface TeamSession { token: string; sessionId: string; expiresAt: Date; cookie: string; user: TeamUserView; }

export function serializeTeamCookie(token: string, options: { maxAgeMs?: number; secure?: boolean; name?: string } = {}): string {
  const maxAge = Math.max(1, Math.floor((options.maxAgeMs ?? DEFAULT_SESSION_TTL_MS) / 1000));
  const secure = options.secure ? "; Secure" : "";
  return (options.name ?? TEAM_SESSION_COOKIE) + "=" + encodeURIComponent(token) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge + secure;
}

export function setTeamSessionCookie(res: Pick<Response, "setHeader">, session: Pick<TeamSession, "cookie">): void {
  res.setHeader("Set-Cookie", session.cookie);
}

export async function issueTeamSession(db: Db, id: unknown, options: { ttlMs?: number; now?: Date | number; secureCookie?: boolean } = {}): Promise<TeamSession> {
  await assertTeamSchema(db);
  const principal = await getTeamUser(db, id);
  const token = crypto.randomBytes(32).toString("base64url");
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(nowDate(options.now).getTime() + (options.ttlMs ?? DEFAULT_SESSION_TTL_MS));
  await asDb(db)(TEAM_SESSIONS).insert({ id: sessionId, token_hash: digestToken(token), user_id: principal.id, session_revision: principal.sessionRevision, expires_at: expiresAt });
  const user: TeamUserView = { id: principal.id, name: principal.name, role: principal.role, enabled: principal.enabled, version: principal.version };
  return { token, sessionId, expiresAt, cookie: serializeTeamCookie(token, { maxAgeMs: options.ttlMs, secure: options.secureCookie }), user };
}

export async function resolveTeamSession(db: Db, token: string, options: { now?: Date | number } = {}): Promise<TeamPrincipal> {
  if (typeof token !== "string" || token.length < 32) throw new TeamSecurityError("SESSION_INVALID", "会话无效", 401);
  if (!(await hasTable(db, TEAM_SESSIONS))) throw new TeamSecurityError("TEAM_SCHEMA_REQUIRED", "团队安全架构尚未初始化", 503);
  const row = await asDb(db)(TEAM_SESSIONS).where({ token_hash: digestToken(token) }).whereNull("revoked_at").where("expires_at", ">", nowDate(options.now)).select("id as session_id", "user_id", "session_revision").first();
  if (!row) throw new TeamSecurityError("SESSION_INVALID", "会话无效或已过期", 401);
  const principal = await getTeamUser(db, row.user_id);
  if (principal.sessionRevision !== Number(row.session_revision)) throw new TeamSecurityError("SESSION_REVOKED", "会话已撤销", 401);
  return { ...principal, sessionId: String(row.session_id) };
}

export async function revokeTeamSession(db: Db, token: string): Promise<void> {
  if (!(await hasTable(db, TEAM_SESSIONS))) return;
  await asDb(db)(TEAM_SESSIONS).where({ token_hash: digestToken(token) }).whereNull("revoked_at").update({ revoked_at: new Date() });
}

export async function revokeTeamUserSessions(db: Db, id: unknown): Promise<void> {
  const targetId = userId(id);
  await assertTeamSchema(db);
  await asDb(db)(TEAM_USERS).where({ user_id: targetId }).increment("session_revision", 1).update({ updated_at: asDb(db).fn.now() });
  await asDb(db)(TEAM_SESSIONS).where({ user_id: targetId }).whereNull("revoked_at").update({ revoked_at: new Date() });
}

export function extractTeamSessionToken(req: Pick<Request, "headers">): string | undefined {
  const cookieHeader = req.headers.cookie;
  const cookieName = `${TEAM_SESSION_COOKIE}=`;
  const cookie = cookieHeader?.split(";").map((part) => part.trim()).find((part) => part.startsWith(cookieName));
  if (cookie) return decodeURIComponent(cookie.slice(cookieName.length));
  const authorization = req.headers.authorization;
  if (authorization?.match(/^Bearer\s+/i)) return authorization.replace(/^Bearer\s+/i, "").trim();
}

export interface OriginRequest { method?: string; headers: { origin?: string; host?: string; [key: string]: unknown }; }

export function validateRequestOrigin(req: OriginRequest, allowedOrigins: readonly string[] = []): boolean {
  if (SAFE_METHODS.has(String(req.method ?? "GET").toUpperCase())) return true;
  const origin = req.headers.origin;
  if (!origin || origin === "null") return false;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  const normalized = `${parsed.protocol}//${parsed.host}`;
  if (allowedOrigins.includes(normalized) || allowedOrigins.includes(origin)) return true;
  const host = req.headers.host;
  return typeof host === "string" && (normalized === `http://${host}` || normalized === `https://${host}`);
}

export function assertRequestOrigin(req: OriginRequest, allowedOrigins: readonly string[] = []): void {
  if (!validateRequestOrigin(req, allowedOrigins)) throw new TeamSecurityError("CSRF_ORIGIN", "请求来源未获允许", 403);
}

export function teamAuthMiddleware(db: Db, options: { allowedOrigins?: readonly string[]; requireOrigin?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = extractTeamSessionToken(req);
      if (!token) throw new TeamSecurityError("SESSION_REQUIRED", "需要团队会话", 401);
      if (options.requireOrigin !== false) assertRequestOrigin(req, options.allowedOrigins);
      const principal = await resolveTeamSession(db, token);
      (req as any).teamPrincipal = principal;
      next();
    } catch (error) {
      const e = error instanceof TeamSecurityError ? error : new TeamSecurityError("AUTH_FAILED", "认证失败", 401);
      res.status(e.status).send({ code: e.code, message: e.message });
    }
  };
}

export function projectAccessMiddleware(db: Db, action: ProjectAction, getProject: (req: Request) => unknown) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const principal = (req as any).teamPrincipal as TeamPrincipal | undefined;
      if (!principal) throw new TeamSecurityError("SESSION_REQUIRED", "需要团队会话", 401);
      (req as any).teamPrincipal = await requireProjectAccess(db, principal.id, getProject(req), action);
      next();
    } catch (error) {
      const e = error instanceof TeamSecurityError ? error : new TeamSecurityError("ACCESS_FAILED", "访问被拒绝", 403);
      res.status(e.status).send({ code: e.code, message: e.message });
    }
  };
}

export async function associateProjectWithTeam(db: Db, project: unknown): Promise<void> {
  await assertTeamSchema(db);
  const pid = projectId(project);
  const row = await asDb(db)("o_project").where({ id: pid }).select("id", "userId").first();
  if (!row) throw new TeamSecurityError("PROJECT_NOT_FOUND", "项目不存在", 404);
  const owner = await asDb(db)(TEAM_USERS).where({ user_id: row.userId }).first();
  if (!owner) throw new TeamSecurityError("PROJECT_FORBIDDEN", "项目所有者不是团队成员", 403);
  await asDb(db)(TEAM_PROJECTS).insert({ project_id: pid, team_key: SHARED_TEAM_KEY }).onConflict("project_id").ignore();
}

export { TEAM_USERS, TEAM_SESSIONS, TEAM_PROJECTS, hasTable as teamSchemaHasTable, userId as normalizeTeamUserId };

// Stable short aliases for integration code that does not need the Team prefix.
export const issueSession = issueTeamSession;
export const resolveSession = resolveTeamSession;
export const revokeSession = revokeTeamSession;
export const revokeUserSessions = revokeTeamUserSessions;
export const createTeamAuthMiddleware = teamAuthMiddleware;
