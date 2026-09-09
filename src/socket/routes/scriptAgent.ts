import { Namespace, Socket } from "socket.io";
import { defaultBuiltinRunLimits, type BuiltinRunLimits } from "@/services/builtinAgent/contracts";
import {
  authenticateBuiltinSocket,
  authorizeSocketContext,
  deriveIsolationKey,
  disconnectSocket,
  parsePositiveId,
  refreshSocketPrincipal,
  type BuiltinSocketDependencies,
} from "@/socket/builtinSocketAuth";

interface ChatPayload { content?: unknown; prompt?: unknown; idempotencyKey?: unknown; limits?: unknown; }
type Ack = (result: Record<string, unknown>) => void;

function limits(value: unknown): BuiltinRunLimits {
  if (value === undefined) return { ...defaultBuiltinRunLimits };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("LIMITS_INVALID");
  const source = value as Record<string, unknown>;
  const result = { ...defaultBuiltinRunLimits };
  for (const key of Object.keys(result) as Array<keyof BuiltinRunLimits>) {
    if (source[key] === undefined) continue;
    if (!Number.isSafeInteger(source[key]) || Number(source[key]) < 0) throw new Error("LIMITS_INVALID");
    result[key] = Number(source[key]);
  }
  return result;
}

function chatInput(data: ChatPayload): { prompt: string; idempotencyKey: string; limits: BuiltinRunLimits } {
  const prompt = typeof data?.prompt === "string" ? data.prompt : data?.content;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 100_000) throw new Error("PROMPT_INVALID");
  if (typeof data.idempotencyKey !== "string" || !/^[\w:.-]{8,150}$/.test(data.idempotencyKey)) throw new Error("IDEMPOTENCY_REQUIRED");
  return { prompt: prompt.trim(), idempotencyKey: data.idempotencyKey, limits: limits(data.limits) };
}

export interface ScriptAgentSocketOptions extends BuiltinSocketDependencies {}

export function createScriptAgentSocketRoute(dependencies: ScriptAgentSocketOptions) {
  return (nsp: Namespace) => {
    nsp.on("connection", async (socket: Socket) => {
      let principal;
      let context: { projectId: number; scriptId: number | null; isolationKey: string };
      try {
        principal = await authenticateBuiltinSocket(socket, dependencies);
        const projectId = parsePositiveId(socket.handshake.auth?.projectId, "PROJECT");
        const rawScript = socket.handshake.auth?.scriptId;
        const scriptId = rawScript == null || rawScript === "" ? null : parsePositiveId(rawScript, "SCRIPT");
        context = { projectId, scriptId, isolationKey: deriveIsolationKey("scriptAgent", projectId, scriptId) };
        await authorizeSocketContext(dependencies, principal, context, "read");
      } catch {
        disconnectSocket(socket);
        return;
      }

      const currentPrincipal = async () => {
        principal = await refreshSocketPrincipal(socket, dependencies);
        await authorizeSocketContext(dependencies, principal, context, "read");
        return principal;
      };

      socket.on("chat", async (data: ChatPayload, callback?: Ack) => {
        try {
          const actor = await currentPrincipal();
          await authorizeSocketContext(dependencies, actor, context, "edit");
          const input = chatInput(data);
          const result = await dependencies.runtime.create({ agentType: "scriptAgent", projectId: context.projectId, scriptId: context.scriptId, requestedBy: actor.id, prompt: input.prompt, idempotencyKey: input.idempotencyKey, limits: input.limits });
          socket.emit("builtinRunCreated", { runId: result.run.id, reused: result.reused, isolationKey: context.isolationKey });
          callback?.({ success: true, runId: result.run.id, reused: result.reused });
        } catch (error) { callback?.({ success: false, code: errorCode(error), message: "内置 Agent 任务未创建，请刷新后重试" }); if (shouldDisconnect(error)) disconnectSocket(socket); }
      });

      socket.on("updateThinkConfig", async (_data: unknown, callback?: Ack) => {
        try { await currentPrincipal(); callback?.({ success: true }); }
        catch (error) { callback?.({ success: false, code: errorCode(error) }); disconnectSocket(socket); }
      });

      // Disconnect only unsubscribes this socket. Persisted runs remain server-owned.
      socket.on("disconnect", () => undefined);
    });
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String((error as { code: unknown }).code);
  return error instanceof Error ? error.message : "SOCKET_ACTION_FAILED";
}

function shouldDisconnect(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && Number((error as { status?: unknown }).status) === 401);
}

export default (nsp: Namespace) => {
  // Resolve the production singleton only when the application registers the route.
  // Factory tests can inject an isolated DB/runtime without opening DATABASE_URL.
  const utils = require("@/utils").default;
  const { getBuiltinAgentRuntime } = require("@/services/builtinAgent/runtime") as typeof import("@/services/builtinAgent/runtime");
  return createScriptAgentSocketRoute({ db: utils.db, runtime: getBuiltinAgentRuntime() })(nsp);
};
