import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/productionAgent/index";
import ResTool from "@/socket/resTool";
import { productionEvents, type ProductionChange } from "@/services/productionEvents";

async function verifyToken(rawToken: string): Promise<number | null> {
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting) return null;
  const { value: tokenKey } = setting;
  if (!rawToken) return null;
  const token = rawToken.replace("Bearer ", "");
  try {
    const decoded = jwt.verify(token, tokenKey as string) as jwt.JwtPayload;
    return Number.isSafeInteger(decoded.id) && decoded.id > 0 ? decoded.id : null;
  } catch (err) {
    return null;
  }
}

export default (nsp: Namespace) => {
  nsp.on("connection", async (socket: Socket) => {
    const token = socket.handshake.auth.token;
    const userId = typeof token === "string" ? await verifyToken(token) : null;
    if (!userId) {
      console.log("[productionAgent] 连接失败，token无效");
      socket.disconnect();
      return;
    }
    const authorizeContext = async (projectId: number, scriptId: number) => {
      if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(scriptId) || projectId <= 0 || scriptId <= 0) return false;
      const user = await u.db("o_user").where({ id: userId }).first();
      const project = await u.db("o_project").where({ id: projectId, userId }).first();
      const script = await u.db("o_script").where({ id: scriptId, projectId }).first();
      return Boolean(user && project && script);
    };
    const projectId = Number(socket.handshake.auth.projectId);
    const scriptId = Number(socket.handshake.auth.scriptId);
    if (!(await authorizeContext(projectId, scriptId))) { socket.disconnect(); return; }
    let isolationKey = `${projectId}:productionAgent:${scriptId}`;
    if (!isolationKey) {
      console.log("[productionAgent] 连接失败，缺少 isolationKey");
      socket.disconnect();
      return;
    }

    console.log("[productionAgent] 已连接:", socket.id);

    let resTool = new ResTool(socket, {
      projectId,
      scriptId,
    });
    let abortController: AbortController | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("updateContext", async (data: { isolationKey: string; projectId: number; scriptId: number }, callback) => {
      const projectId = Number(data.projectId), scriptId = Number(data.scriptId);
      if (!(await authorizeContext(projectId, scriptId))) return callback?.({ success: false, message: "无权访问该剧集" });
      abortController?.abort();
      isolationKey = `${projectId}:productionAgent:${scriptId}`;
      resTool = new ResTool(socket, {
        projectId,
        scriptId,
      });
      console.log("[productionAgent] 上下文已更新:", isolationKey);
      callback?.({ success: true });
    });

    const onProductionChange = (change: ProductionChange) => {
      if (change.projectId === Number(resTool.data.projectId) && change.scriptId === Number(resTool.data.scriptId)) {
        socket.emit("productionStateChanged", change);
      }
    };
    productionEvents.on("changed", onProductionChange);
    socket.on("disconnect", () => {
      productionEvents.off("changed", onProductionChange);
      abortController?.abort();
    });

    socket.on("chat", async (data: { content: string }) => {
      const { content } = data;
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "视频策划");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool,
        msg,
        thinkConfig,
      };

      try {
        await agent.runDecisionAI(ctx);
      } catch (err: any) {
        if (err.name !== "AbortError" && !currentController.signal.aborted) {
          console.error("[productionAgent] chat error:", u.error(err).message);
        }
      } finally {
        if (abortController === currentController) {
          abortController = null;
        }
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[productionAgent] 更新思考配置:", thinkConfig);
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });
  });
  nsp.on("disconnect", (socket: Socket) => {
    console.log("[productionAgent] 已断开连接:", socket.id);
  });
};
