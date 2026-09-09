import type { Knex } from "knex";
import type { Socket } from "socket.io";
import {
  assertRequestOrigin,
  extractTeamSessionToken,
  requireProjectAccess,
  resolveTeamSession,
  type ProjectAccessPrincipal,
  type TeamPrincipal,
} from "@/services/team";
import type { BuiltinAgentRuntime } from "@/services/builtinAgentRuntime";

export interface BuiltinSocketDependencies {
  db: Knex;
  runtime: BuiltinAgentRuntime;
  allowedOrigins?: readonly string[];
}

export interface SocketContext {
  projectId: number;
  scriptId: number | null;
  isolationKey: string;
}

function headerValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/** Socket handshakes are GET requests, but cookie auth still requires an explicit Origin. */
export async function authenticateBuiltinSocket(socket: Socket, dependencies: BuiltinSocketDependencies): Promise<TeamPrincipal> {
  const headers = socket.handshake.headers as Record<string, unknown>;
  assertRequestOrigin({ method: "POST", headers: { origin: headerValue(headers.origin), host: headerValue(headers.host) } }, dependencies.allowedOrigins);
  const cookieToken = extractTeamSessionToken({ headers: { cookie: headerValue(headers.cookie) } });
  if (!cookieToken) throw new Error("TEAM_SESSION_REQUIRED");
  return resolveTeamSession(dependencies.db, cookieToken);
}

export async function authorizeSocketContext(
  dependencies: BuiltinSocketDependencies,
  principal: TeamPrincipal,
  context: Pick<SocketContext, "projectId" | "scriptId">,
  action: "read" | "edit",
): Promise<ProjectAccessPrincipal> {
  const access = await requireProjectAccess(dependencies.db, principal.id, context.projectId, action);
  if (context.scriptId != null) {
    const script = await dependencies.db("o_script").where({ id: context.scriptId, projectId: context.projectId }).first();
    if (!script) throw new Error("SCRIPT_PROJECT_MISMATCH");
  }
  return access;
}

export async function refreshSocketPrincipal(socket: Socket, dependencies: BuiltinSocketDependencies): Promise<TeamPrincipal> {
  return authenticateBuiltinSocket(socket, dependencies);
}

export function parsePositiveId(value: unknown, label: string): number {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || (id as number) <= 0) throw new Error(`${label}_INVALID`);
  return id as number;
}

export function deriveIsolationKey(agentType: "scriptAgent" | "productionAgent", projectId: number, scriptId: number | null): string {
  return `${projectId}:${agentType}:${scriptId == null ? "project" : scriptId}`;
}

export function disconnectSocket(socket: Socket): void {
  try { socket.disconnect(true); } catch { socket.disconnect(); }
}
