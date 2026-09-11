// import "./logger";
import "./err";
import "./env";
import express, { Request, Response, NextFunction } from "express";
import { Server } from "socket.io";
import http from "node:http";
import expressWs from "express-ws";
import logger from "morgan";
import cors from "cors";
import buildRoute from "@/core";
import path from "path";
import fs from "fs";
import u from "@/utils";
import { agentGatewayConfigFromEnv, createAgentGateway } from "@/services/agentGateway";
import { resumeVideoJobs, getRuntimeVideoJobService } from "@/services/videoJobs/runtime";
import { dbReady } from "@/utils/db";
import socketInit from "@/socket/index";
import { isEletron } from "@/utils/getPath";
import { ensureThumbnail, ThumbnailSize } from "@/utils/image";
import { getBuiltinAgentRuntime, authorizeBuiltinProject } from "@/services/builtinAgent/runtime";
import { createBuiltinAgentRouter } from "@/services/builtinAgent/http";
import { finishLegacyProductionWaits } from "@/services/builtinAgent/finishLegacyProductionWaits";
import { createTeamRouter } from "@/routes/team";
import { createApplicationSessionRouter, applicationAllowedOrigins } from "@/services/applicationSession";
import { teamAuthMiddleware, type TeamPrincipal } from "@/services/team";
import { authorizeRoute, resolveAuthorizedMedia } from "@/services/team/authorization";
import { getProductionImageGenerationService } from "@/services/productionImageJobRuntime";
import { configureMediaJobRecoveryExecutors } from "@/services/mediaJobControl";
import { cleanupExpiredVideoReferenceLeases, ensureVideoReferenceBridgeSchema } from "@/services/videoReferenceBridge";
import { createVideoReferenceBridgeRouter } from "@/services/videoReferenceBridge/http";
import { ensureVideoPromptJobSchema } from "@/services/videoPromptJobs";
import { ensurePromptRegistrySchema } from "@/services/promptRegistry";
import { getProductionImageReviewService } from "@/services/imageReviews/runtime";

const app = express();
const server = http.createServer(app);
let ioServer: Server | undefined;

async function checkPermissions() {
  if (!isEletron()) return true;
  const userDataPath = u.getPath();
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    const testFile = path.join(userDataPath, ".access_test");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
  } catch (e) {
    const { dialog, app } = require("electron");
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "权限不足",
      message: "应用无法访问数据目录",
      detail: `无法读写以下目录：\n${userDataPath}\n\n请联系管理员授予权限，或以管理员身份运行本程序。`,
      buttons: ["确认退出"],
      defaultId: 0,
    });
    if (response === 0) {
      app.quit();
    }
  }
}

export default async function startServe(randomPort: Boolean = false) {
  await dbReady;
  await ensurePromptRegistrySchema(u.db);
  await ensureVideoPromptJobSchema(u.db);
  await ensureVideoReferenceBridgeSchema(u.db);
  await cleanupExpiredVideoReferenceLeases(u.db);
  await finishLegacyProductionWaits(u.db);
  await checkPermissions();
  await u.oss.ready();
  configureMediaJobRecoveryExecutors({ image: getProductionImageGenerationService(), video: getRuntimeVideoJobService() });
  getProductionImageGenerationService().start();
  getProductionImageReviewService().start();
  void resumeVideoJobs().catch((error) => console.error("[videoJobs] recovery failed", error instanceof Error ? error.name : "UnknownError"));

  await u.writeVersion();
  const io = new Server(server, { cors: { origin: "*" } });
  ioServer = io;
  socketInit(io);

  if (process.env.NODE_ENV == "dev") await buildRoute();

  expressWs(app);

  app.use(logger("dev", { skip: (req) => req.path === "/media-bridge" || req.path.startsWith("/media-bridge/") }));
  app.use(cors({ origin: "*" }));
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));
  const allowedOrigins = applicationAllowedOrigins();
  const authenticate = teamAuthMiddleware(u.db, { allowedOrigins });
  app.use("/api/session", createApplicationSessionRouter({
    db: u.db,
    secureCookies: process.env.NODE_ENV === "prod",
    allowedOrigins,
    legacySigningKey: async () => String((await u.db("o_setting").where({ key: "tokenKey" }).first())?.value ?? ""),
  }));

  // oss 静态资源
  const ossDir = u.getPath("oss");
  if (!process.env.TOONFLOW_MEDIA_DIR && !fs.existsSync(ossDir)) {
    fs.mkdirSync(ossDir, { recursive: true });
  }
  console.log("文件目录:", ossDir);

  // KZ reference leases are bearer URLs for one verified file. They are
  // deliberately outside /oss, whose team-session middleware would prevent
  // an upstream provider from downloading a selected reference.
  app.use("/media-bridge", createVideoReferenceBridgeRouter({
    db: u.db,
    rootDir: ossDir,
    secret: String(process.env.TOONFLOW_MEDIA_BRIDGE_SECRET || ""),
    publicOrigin: process.env.TOONFLOW_MEDIA_PUBLIC_ORIGIN,
  }));

  app.use(
    "/oss",
    authenticate,
    async (req, res, next) => {
      try {
        const filePath = decodeURIComponent(req.path);
        if (filePath.includes("\\") || filePath.split("/").some((part) => part === ".." || part === ".") || filePath.includes("\0")) return res.status(403).end();
        const principal = (req as any).teamPrincipal as TeamPrincipal;
        await resolveAuthorizedMedia(u.db, principal.id, { filePath });
        res.setHeader("Cache-Control", "private, no-store");
        next();
      } catch { return res.status(403).send({ code: "MEDIA_FORBIDDEN", message: "无权访问此媒体" }); }
    },
    (req, res, next) => {
      // 如果传参 type=small，则返回小图
      if (req.query.size) {
        const size = req.query.size as string;
        const smallImageBaseDir = path.join(ossDir, "smallImage");
        const originalPath = path.join(ossDir, req.path);

        // 解析 size 参数
        let sizeSubDir: string;
        let sizeOpts: ThumbnailSize | undefined;

        // 判断是否为 WIDTHxHEIGHT 格式，如 "200x300"：等比压缩到指定宽高边界
        const dimensMatch = size.match(/^(\d+)x(\d+)$/i);
        // 判断是否为百分比格式，如 "30"、"30%"：等比压缩到原图的指定百分比
        const percentMatch = size.match(/^(\d+(?:\.\d+)?)\s*%?$/);

        if (dimensMatch) {
          const w = parseInt(dimensMatch[1], 10);
          const h = parseInt(dimensMatch[2], 10);
          sizeSubDir = `${w}x${h}`;
          sizeOpts = { type: "dimensions", width: w, height: h };
        } else if (percentMatch) {
          const pct = parseFloat(percentMatch[1]);
          sizeSubDir = `${percentMatch[1]}p`;
          sizeOpts = { type: "percentage", value: pct };
        } else {
          // 无效的 size 参数，降级返回原图
          express.static(ossDir, { acceptRanges: false })(req, res, next);
          return;
        }

        const ext = path.extname(req.path);
        const base = path.basename(req.path, ext);
        const dir = path.dirname(req.path);
        const smallImagePath = path.join(smallImageBaseDir, dir, `${base}_${sizeSubDir}${ext}`);

        ensureThumbnail(originalPath, smallImagePath, sizeOpts).then((thumbnailPath) => {
          if (thumbnailPath) {
            // A configured media root may itself be inside a dot-directory.
            // Resolve relative to that trusted root so Express does not reject
            // the root's name as an untrusted dotfile request.
            res.sendFile(path.relative(ossDir, thumbnailPath), { root: ossDir });
          } else {
            // 缩略图生成失败，降级返回原图
            express.static(ossDir, { acceptRanges: false })(req, res, next);
          }
        });
        return;
      }
      next();
    },
    express.static(ossDir, { acceptRanges: true }),
  );
  // skills 静态资源
  const skillsDir = u.getPath("skills");
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }
  console.log("文件目录:", skillsDir);
  // 只允许图片文件访问
  app.use(
    "/skills",
    (req, res, next) => {
      /\.(jpe?g|png|gif|webp|svg|ico|bmp)$/i.test(req.path) ? next() : res.status(403).end();
    },
    express.static(skillsDir, { acceptRanges: false }),
  );

  // assets 静态资源
  const assetsDir = u.getPath("assets");
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }
  console.log("文件目录:", assetsDir);
  app.use("/assets", express.static(assetsDir, { acceptRanges: false }));

  // data/web 静态网站
  const webDir = u.getPath("web");
  if (fs.existsSync(webDir)) {
    console.log("静态网站目录:", webDir);
    app.use(express.static(webDir, { acceptRanges: false }));
  } else {
    console.warn("静态网站目录不存在:", webDir);
  }

  app.use("/api/agent", createAgentGateway(u.db, agentGatewayConfigFromEnv(process.env), (path) => u.oss.getSmallImageUrl(path)));

  app.use("/api", (req, res, next) => {
    if (req.path === "/login/login") return next();
    return authenticate(req, res, async () => {
      try {
        const principal = (req as any).teamPrincipal as TeamPrincipal;
        (req as any).user = principal;
        const exactPath = req.originalUrl.split("?")[0].replace(/\/$/, "");
        await authorizeRoute({ db: u.db, getMedia: (request) => {
          const raw = String(request.body?.url ?? request.body?.path ?? "");
          const url = new URL(raw, "http://local.invalid");
          if (!url.pathname.startsWith("/oss/")) throw new Error("Invalid media reference");
          return { filePath: decodeURIComponent(url.pathname.slice(4)) };
        } }, req.method, exactPath, principal, req);
        next();
      } catch (error) {
        const value = error as { status?: number; code?: string; message?: string };
        res.status(value.status ?? 403).send({ code: value.code ?? "FORBIDDEN", message: value.message ?? "操作未获授权" });
      }
    });
  });

  app.use("/api/team", createTeamRouter({ db: u.db, authenticate: async (req) => (req as any).teamPrincipal }));
  app.use("/api/builtinAgent", createBuiltinAgentRouter({
    runtime: getBuiltinAgentRuntime(),
    userId: async (req) => Number((req as any).user?.id),
    authorize: authorizeBuiltinProject,
  }));
  getBuiltinAgentRuntime().start();

  const router = await import("@/router");
  await router.default(app);

  // 404 处理
  app.use((_, res, next: NextFunction) => {
    return res.status(404).send({ message: "API 404 Not Found" });
  });

  // 错误处理
  app.use((err: any, _: Request, res: Response, __: NextFunction) => {
    res.locals.message = err.message;
    res.locals.error = err;
    console.error(err);
    res.status(err.status || 500).send(err);
  });

  const port = randomPort ? 0 : Number(process.env.TOONFLOW_PORT || 10588);
  return await new Promise((resolve) => {
    server.listen(port, process.env.TOONFLOW_HOST || "127.0.0.1", async () => {
      const address = server.address();
      const realPort = typeof address === "string" ? address : address?.port;
      console.log(`[服务启动成功]: http://localhost:${realPort}`);
      resolve(realPort);
    });
  });
}

// 支持await关闭
export async function closeServe(): Promise<void> {
  getProductionImageReviewService().stop();
  getProductionImageGenerationService().stop();
  getRuntimeVideoJobService().stop();
  await getBuiltinAgentRuntime().stop();
  ioServer?.disconnectSockets(true);
  return new Promise((resolve, reject) => {
    if (server) {
      server.close((err?: Error) => {
        if (err) return reject(err);
        console.log("[服务已关闭]");
        resolve();
      });
    } else {
      resolve();
    }
  });
}

const isElectron = typeof process.versions?.electron !== "undefined";
if (!isElectron) startServe();
