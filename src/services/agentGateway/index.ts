import { Router } from "express";
import { withProjectTransaction } from "../../lib/dbTransaction";
import type { Knex } from "knex";
import { createHash, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import {
  ProductionStateService,
  ProductionStateError,
} from "../productionState";
import { readProductionFlow, ProductionFlowError } from "../productionFlow";
import { notifyProductionChange } from "../productionEvents";

export interface AgentGatewayConfig {
  token: string;
  userId: number;
  projectIds: number[];
  allowStoryboardWrite: boolean;
}
const positiveId = z.number().int().positive();
const configSchema = z.object({
  token: z.string().min(32).max(512).regex(/^\S+$/),
  userId: positiveId,
  projectIds: z.array(positiveId).min(1).max(100),
  allowStoryboardWrite: z.boolean(),
});
export function agentGatewayConfigFromEnv(
  env: NodeJS.ProcessEnv,
): AgentGatewayConfig | null {
  const parsed = configSchema.safeParse({
    token: env.TOONFLOW_AGENT_TOKEN,
    userId: Number(env.TOONFLOW_AGENT_USER_ID),
    projectIds: env.TOONFLOW_AGENT_PROJECT_IDS?.split(",").map(Number),
    allowStoryboardWrite: env.TOONFLOW_AGENT_ALLOW_STORYBOARD_WRITE === "1",
  });
  return parsed.success ? parsed.data : null;
}
export async function ensureAgentGatewaySchema(db: Knex) {
  if (!(await db.schema.hasTable("ext_agent_mutations")))
    await db.schema.createTable("ext_agent_mutations", (table) => {
      table.text("agentId").notNullable();
      table.integer("projectId").notNullable();
      table.text("idempotencyKey").notNullable();
      table.text("requestHash").notNullable();
      table.text("reason").notNullable();
      table.text("result").notNullable();
      table.bigInteger("createdAt").notNullable();
      table.primary(["agentId", "projectId", "idempotencyKey"]);
    });
}
class GatewayError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const hash = (input: string) => createHash("sha256").update(input).digest();
const projectSchema = z.object({ projectId: positiveId }).strict();
const listSchema = projectSchema.extend({
  afterId: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
const storyboardSchema = projectSchema.extend({ storyboardId: positiveId });
const editSchema = storyboardSchema.extend({
  expectedVersion: z.number().int().nonnegative(),
  prompt: z.string().max(100000),
  videoDesc: z.string().max(100000),
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z
    .string()
    .min(16)
    .max(100)
    .regex(/^[\w-]+$/),
});

export function createAgentGateway(
  db: Knex,
  suppliedConfig: AgentGatewayConfig | null,
  getUrl: (path: string) => Promise<string>,
) {
  const configResult = configSchema.safeParse(suppliedConfig);
  const config = configResult.success ? configResult.data : null;
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!config)
      return res
        .status(503)
        .json({
          code: "AGENT_GATEWAY_DISABLED",
          message: "Agent gateway is not configured",
        });
    // The service credential is never accepted from query/body or forwarded to regular user routes.
    const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || "");
    if (!match || !timingSafeEqual(hash(match[1]), hash(config.token)))
      return res
        .status(401)
        .json({ code: "UNAUTHORIZED", message: "Invalid agent credential" });
    next();
  });
  const scoped = async (projectId?: number) => {
    if (!config)
      throw new GatewayError(
        503,
        "AGENT_GATEWAY_DISABLED",
        "Agent gateway is not configured",
      );
    const user = await db("o_user").where({ id: config.userId }).first();
    if (!user)
      throw new GatewayError(
        403,
        "FORBIDDEN",
        "Service account owner is unavailable",
      );
    if (
      projectId != null &&
      (!config.projectIds.includes(projectId) ||
        !(await db("o_project")
          .where({ id: projectId, userId: config.userId })
          .first()))
    ) {
      throw new GatewayError(
        403,
        "FORBIDDEN",
        "Project is outside this agent scope",
      );
    }
    return config;
  };
  const route = (
    name: string,
    operation: (input: unknown) => Promise<unknown>,
  ) =>
    router.post(name, async (req, res) => {
      try {
        res.json({ code: 200, data: await operation(req.body) });
      } catch (error) {
        if (error instanceof ZodError)
          return res
            .status(400)
            .json({
              code: "INVALID_INPUT",
              message: "Invalid request arguments",
            });
        if (error instanceof GatewayError)
          return res
            .status(error.status)
            .json({ code: error.code, message: error.message });
        if (error instanceof ProductionStateError) {
          const status = {
            NOT_FOUND: 404,
            PROJECT_MISMATCH: 404,
            VERSION_CONFLICT: 409,
            LOCKED: 423,
            FORBIDDEN: 403,
            INVALID_INPUT: 400,
          }[error.code];
          return res
            .status(status)
            .json({ code: error.code, message: error.message });
        }
        if (error instanceof ProductionFlowError)
          return res
            .status(error.status)
            .json({ code: "INVALID_PROJECT_STATE", message: error.message });
        return res
          .status(500)
          .json({ code: "INTERNAL_ERROR", message: "Agent operation failed" });
      }
    });
  route("/capabilities", async (input) => {
    z.object({}).strict().parse(input);
    const scope = await scoped();
    return {
      protocol: 1,
      read: true,
      storyboardWrite: scope.allowStoryboardWrite,
      approve: false,
      generate: false,
    };
  });
  route("/projects", async (input) => {
    z.object({}).strict().parse(input);
    const scope = await scoped();
    return db("o_project")
      .where({ userId: scope.userId })
      .whereIn("id", scope.projectIds)
      .select("id", "name", "intro", "projectType", "videoRatio")
      .orderBy("id");
  });
  route("/episodes", async (input) => {
    const data = listSchema.parse(input);
    await scoped(data.projectId);
    return db("o_script")
      .where({ projectId: data.projectId })
      .where("id", ">", data.afterId)
      .select("id", "projectId", "name", "createTime")
      .orderBy("id")
      .limit(data.limit);
  });
  route("/flow", async (input) => {
    const data = projectSchema.extend({ scriptId: positiveId }).parse(input);
    await scoped(data.projectId);
    return readProductionFlow(db, data.projectId, data.scriptId, getUrl);
  });
  route("/storyboard", async (input) => {
    const data = storyboardSchema.parse(input);
    await scoped(data.projectId);
    return new ProductionStateService(db).getStoryboardState(
      data.projectId,
      data.storyboardId,
    );
  });
  route("/tasks", async (input) => {
    const data = listSchema.parse(input);
    await scoped(data.projectId);
    const videos = await db("o_video")
      .where({ projectId: data.projectId })
      .where("id", ">", data.afterId)
      .select("id", "scriptId", "videoTrackId", "state", "time")
      .orderBy("id")
      .limit(data.limit);
    const jobs = (await db.schema.hasTable("ext_video_jobs"))
      ? await db("ext_video_jobs")
          .where({ projectId: data.projectId })
          .whereIn(
            "videoId",
            videos.map((video) => video.id),
          )
          .select("videoId", "status", "pollAttempts", "updatedAt")
      : [];
    return videos.map((video) => ({
      ...video,
      job: jobs.find((job) => job.videoId === video.id) ?? null,
    }));
  });
  route("/storyboard/update", async (input) => {
    const data = editSchema.parse(input);
    const scope = await scoped(data.projectId);
    if (!scope.allowStoryboardWrite)
      throw new GatewayError(
        403,
        "READ_ONLY",
        "This agent has read-only access",
      );
    const agentId = `agent:owner:${scope.userId}`;
    const requestHash = hash(
      JSON.stringify({
        storyboardId: data.storyboardId,
        expectedVersion: data.expectedVersion,
        prompt: data.prompt,
        videoDesc: data.videoDesc,
        reason: data.reason,
      }),
    ).toString("hex");
    const result = await withProjectTransaction(db, data.projectId, async (trx) => {
      const key = {
        agentId,
        projectId: data.projectId,
        idempotencyKey: data.idempotencyKey,
      };
      const existing = await trx("ext_agent_mutations").where(key).first();
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new GatewayError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was used for a different request",
          );
        return { ...JSON.parse(existing.result), replayed: true };
      }
      const updated = await new ProductionStateService(
        trx,
      ).updateStoryboardContent({
        projectId: data.projectId,
        storyboardId: data.storyboardId,
        expectedVersion: data.expectedVersion,
        actor: { id: agentId, kind: "agent" },
        patch: { prompt: data.prompt, videoDesc: data.videoDesc },
      });
      await trx("ext_agent_mutations").insert({
        ...key,
        requestHash,
        reason: data.reason,
        result: JSON.stringify(updated),
        createdAt: Date.now(),
      });
      return { ...updated, replayed: false };
    });
    if (!result.replayed)
      notifyProductionChange({
        projectId: data.projectId,
        scriptId: Number(result.storyboard.scriptId),
        storyboardId: data.storyboardId,
      });
    return result;
  });
  router.use((_req, res) =>
    res
      .status(404)
      .json({ code: "NOT_FOUND", message: "Agent operation not available" }),
  );
  return router;
}
