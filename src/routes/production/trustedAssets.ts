import { createHash } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { requestUserId } from "@/services/projectContent/http";
import { requireProjectAccess } from "@/services/team";
import { kickTrustedAssetUpload } from "@/services/volcengineTrustedAssetUploadRuntime";
import { loadVolcengineAssetCredentials, readVolcengineReferenceBindings, replaceVolcengineReferenceBindings, syncVolcengineReferenceBindings, VolcengineTrustedAssetClient, VolcengineTrustedAssetError } from "@/services/volcengineTrustedAssets";
import { createVolcengineAssetUploadRuntime, getVolcengineAssetGroupCreation, getVolcengineAssetUpload, listVolcengineAssetGroupCreations, listVolcengineAssetUploads, startVolcengineAssetGroupCreation, startVolcengineAssetUpload, syncVolcengineAssetGroupCreation, syncVolcengineAssetUpload } from "@/services/volcengineTrustedAssetUploads";

const router = express.Router();
const project = z.object({ projectId: z.coerce.number().int().positive() }).passthrough();
async function context(req: Request, action: "read" | "edit", remote = true) {
  const input = project.parse(req.body), userId = requestUserId(req);
  await requireProjectAccess(u.db, userId, input.projectId, action);
  const client = remote ? new VolcengineTrustedAssetClient({ credentials: await loadVolcengineAssetCredentials(u.db) }) : undefined;
  return { input, userId, client };
}
function sendError(res: Response, error: unknown): Response {
  if (error instanceof z.ZodError) return res.status(400).send({ code: "INVALID_INPUT", message: "素材库参数不完整或格式错误" });
  if (error instanceof VolcengineTrustedAssetError) return res.status(error.status).send({ code: error.code, message: error.message });
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  if ([400, 401, 403, 404, 409, 423, 503].includes(Number(value?.status))) return res.status(Number(value.status)).send({ code: value.code ?? "REQUEST_FAILED", message: value.message ?? "素材库请求失败" });
  return res.status(500).send({ code: "INTERNAL_ERROR", message: "素材库请求失败" });
}
const hashLocalSource = async (filePath: string) => createHash("sha256").update(await u.oss.getImageBase64(filePath)).digest("hex");
const uploadRuntime = () => createVolcengineAssetUploadRuntime(u.db, {
  rootDir: u.getPath("oss"), publicOrigin: String(process.env.TOONFLOW_MEDIA_PUBLIC_ORIGIN || ""), secret: String(process.env.TOONFLOW_MEDIA_BRIDGE_SECRET || ""),
}, hashLocalSource);

router.post("/groups", async (req, res) => { try { const { input, client } = await context(req, "read"); const { projectId: _projectId, ...query } = input; return res.send(success(await client!.listGroups(query))); } catch (error) { return sendError(res, error); } });
router.post("/assets", async (req, res) => { try { const { input, client } = await context(req, "read"); const { projectId: _projectId, ...query } = input; return res.send(success(await client!.listAssets(query))); } catch (error) { return sendError(res, error); } });
router.post("/asset", async (req, res) => { try { const { input, client } = await context(req, "read"); return res.send(success(await client!.getAsset({ id: input.id, projectName: input.projectName }))); } catch (error) { return sendError(res, error); } });
router.post("/group", async (req, res) => { try { const { input, client } = await context(req, "read"); return res.send(success(await client!.getGroup({ id: input.id, projectName: input.projectName }))); } catch (error) { return sendError(res, error); } });
router.post("/getBindings", async (req, res) => { try { const { input } = await context(req, "read", false); return res.send(success(await readVolcengineReferenceBindings(u.db, input as any, hashLocalSource))); } catch (error) { return sendError(res, error); } });
router.post("/setBindings", async (req, res) => { try {
  const requiresRemoteValidation = Array.isArray(req.body?.items) && req.body.items.length > 0;
  const { input, userId, client } = await context(req, "edit", requiresRemoteValidation);
  const result = await replaceVolcengineReferenceBindings(u.db, client, input, `human:${userId}`, hashLocalSource);
  return res.send(success(result));
} catch (error) { return sendError(res, error); } });
router.post("/syncBindings", async (req, res) => { try { const { input, client } = await context(req, "edit"); return res.send(success(await syncVolcengineReferenceBindings(u.db, client!, input as any, hashLocalSource))); } catch (error) { return sendError(res, error); } });
router.post("/createGroup", async (req, res) => { try { const { input, userId, client } = await context(req, "edit"); const result = await startVolcengineAssetGroupCreation(u.db, client!, input, `human:${userId}`); kickTrustedAssetUpload("group", result.operationId); return res.send(success(result)); } catch (error) { return sendError(res, error); } });
router.post("/getGroupCreation", async (req, res) => { try { const { input } = await context(req, "read", false); return res.send(success(await getVolcengineAssetGroupCreation(u.db, input))); } catch (error) { return sendError(res, error); } });
router.post("/listGroupCreations", async (req, res) => { try { const { input } = await context(req, "read", false); return res.send(success(await listVolcengineAssetGroupCreations(u.db, input))); } catch (error) { return sendError(res, error); } });
router.post("/syncGroupCreation", async (req, res) => { try { const { input, client } = await context(req, "edit"); return res.send(success(await syncVolcengineAssetGroupCreation(u.db, client!, input))); } catch (error) { return sendError(res, error); } });
router.post("/startUpload", async (req, res) => { try { const { input, userId, client } = await context(req, "edit"); const result = await startVolcengineAssetUpload(u.db, client!, input, `human:${userId}`, uploadRuntime()); kickTrustedAssetUpload("asset", result.operationId); return res.send(success(result)); } catch (error) { return sendError(res, error); } });
router.post("/getUpload", async (req, res) => { try { const { input } = await context(req, "read", false); return res.send(success(await getVolcengineAssetUpload(u.db, input))); } catch (error) { return sendError(res, error); } });
router.post("/listUploads", async (req, res) => { try { const { input } = await context(req, "read", false); return res.send(success(await listVolcengineAssetUploads(u.db, input))); } catch (error) { return sendError(res, error); } });
router.post("/syncUpload", async (req, res) => { try { const { input, client } = await context(req, "edit"); return res.send(success(await syncVolcengineAssetUpload(u.db, client!, input, uploadRuntime()))); } catch (error) { return sendError(res, error); } });

export default router;
