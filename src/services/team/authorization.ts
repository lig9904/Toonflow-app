import type { Knex } from "knex";
import type { Request } from "express";
import { resolveImageFlowOwner } from "../imageFlowWorkspace";
import {
  TeamSecurityError,
  type ProjectAction,
  requireProjectAccess,
  requireTeamRole,
  type TeamPrincipal,
  type ProjectAccessPrincipal,
} from "./index";

export type RouteScope = "public" | "team" | "project" | "admin" | "media";
export interface RouteAuthorization {
  scope: RouteScope;
  action?: ProjectAction;
  roles?: readonly ("admin" | "editor" | "viewer")[];
  projectField?: string;
  resources?: readonly RouteResourceSelector[];
  mediaItemsField?: string;
}

export interface RouteResourceSelector {
  table: string;
  field: string;
  many?: boolean;
  nestedIdField?: string;
  nestedMany?: boolean;
  optional?: boolean;
}

/**
 * Explicit entries for the shared configuration/maintenance surface. Unknown
 * routes deliberately return undefined so callers can fail closed.
 */
const registry: Record<string, RouteAuthorization> = {};
const add = (method: string, paths: readonly string[], spec: RouteAuthorization) => {
  const frozen = Object.freeze({
    ...spec,
    ...(spec.roles ? { roles: Object.freeze([...spec.roles]) } : {}),
    ...(spec.resources ? { resources: Object.freeze(spec.resources.map((item) => Object.freeze({ ...item }))) } : {}),
  });
  for (const path of paths) registry[`${method} ${path}`] = frozen;
};
const project = (action: ProjectAction, projectField = "projectId", resources?: readonly RouteResourceSelector[]): RouteAuthorization => ({ scope: "project", action, projectField, resources });
const resource = (action: ProjectAction, table: string, field: string, many = false, projectField?: string): RouteAuthorization => ({ scope: "project", action, projectField, resources: [{ table, field, many }] });

add("POST", ["/api/login/login"], { scope: "public" });
add("GET", ["/api/other/getVersion"], { scope: "team", action: "read" });
add("POST", ["/api/team/me", "/api/modelSelect/getModelDetail", "/api/modelSelect/getModelList", "/api/project/getProject", "/api/task/getProject", "/api/task/getTaskCategories", "/api/artStyle/getArtStyle", "/api/project/getVisualManual", "/api/project/queryDirectorManual", "/api/project/visualManual", "/api/setting/loginConfig/getUser"], { scope: "team", action: "read" });
add("POST", ["/api/team/listUsers", "/api/team/createUser", "/api/team/updateUser", "/api/artStyle/addArtStyle", "/api/artStyle/editArtStyle", "/api/artStyle/extractStylePrompt", "/api/other/deleteAllData", "/api/project/addDirectorManual", "/api/project/addVisualManual", "/api/project/deleteDirectorManual", "/api/project/deleteVisualManual", "/api/project/editDirectorlManual", "/api/project/editVisualManual", "/api/test/test",
  "/api/setting/about/checkUpdate", "/api/setting/about/downloadApp", "/api/setting/agentDeploy/agentSetKey", "/api/setting/agentDeploy/deployAgentModel", "/api/setting/agentDeploy/getAgentDeploy", "/api/setting/agentDeploy/getAgentUseMode", "/api/setting/agentDeploy/updateAgentModel", "/api/setting/agentDeploy/updateUseMode", "/api/setting/dbConfig/clearData", "/api/setting/dbConfig/clearTable", "/api/setting/dbConfig/dbInfo", "/api/setting/dbConfig/exportData", "/api/setting/dbConfig/importData", "/api/setting/dev/getSwitchAiDevTool", "/api/setting/dev/updateSwitchAiDevTool", "/api/setting/fileManagement/openFolder", "/api/setting/getTextModel", "/api/setting/memoryConfig/delAllMemory", "/api/setting/memoryConfig/getMemory", "/api/setting/memoryConfig/sureMemory", "/api/setting/modelMap/bindingPrompt", "/api/setting/modelMap/deletePrompt", "/api/setting/modelMap/getImageAndVideoModel", "/api/setting/modelMap/getPromptList", "/api/setting/modelMap/savePrompt", "/api/setting/modelMap/updatePrompt", "/api/setting/promptManage/getPrompt", "/api/setting/promptManage/updatePrompt", "/api/setting/skillManagement/getSkillContent", "/api/setting/skillManagement/getSkillList", "/api/setting/skillManagement/saveSkillContent", "/api/setting/vendorConfig/addVendor", "/api/setting/vendorConfig/addVendorModel", "/api/setting/vendorConfig/deleteVendor", "/api/setting/vendorConfig/delVendorModel", "/api/setting/vendorConfig/enableVendor", "/api/setting/vendorConfig/getCodeByLink", "/api/setting/vendorConfig/getVendorList", "/api/setting/vendorConfig/modelTest", "/api/setting/vendorConfig/modelTest/imageTest", "/api/setting/vendorConfig/modelTest/textTest", "/api/setting/vendorConfig/modelTest/videoTest", "/api/setting/vendorConfig/updateCode", "/api/setting/vendorConfig/updateVendorInputs", "/api/setting/vendorConfig/upVendorModel"], { scope: "admin", roles: ["admin"] });
add("POST", ["/api/setting/loginConfig/updateUserPwd"], { scope: "team", action: "edit" });
add("POST", ["/api/project/addProject"], { scope: "team", action: "edit" });

add("POST", ["/api/agents/getMemory", "/api/general/generalStatistics", "/api/assets/batchGenerationData", "/api/assets/getAssetsApi", "/api/assets/getMaterialData", "/api/cornerScape/getAllAssets", "/api/novel/getNovel", "/api/novel/getNovelData", "/api/novel/getNovelIndex", "/api/novel/event/getEvent", "/api/production/editImage/getImageDefaultModle", "/api/production/getFlowData", "/api/production/getStoryboardData", "/api/production/storyboard/getStoryboardData", "/api/production/workbench/getGenerateData", "/api/production/workbench/getVideoList", "/api/script/getScrptApi", "/api/scriptAgent/getPlanData"], project("read"));
add("POST", ["/api/agents/clearMemory", "/api/assets/addAssets", "/api/assets/addAudioAssets", "/api/assets/uploadClip", "/api/novel/addNovel", "/api/production/editImage/generateFlowImage", "/api/production/editImage/uploadImage", "/api/production/saveFlowData", "/api/production/storyboard/addStoryboard", "/api/production/storyboard/batchAddStoryboardInfo", "/api/production/workbench/addTrack", "/api/production/workbench/batchGeneratePrompt", "/api/production/workbench/batchGenerateVideo", "/api/production/workbench/generateVideo", "/api/production/workbench/generateVideoPrompt", "/api/script/batchAddScript", "/api/scriptAgent/setPlanData", "/api/scriptAgent/updateData"], project("edit"));
add("POST", ["/api/assetsGenerate/batchGenerateImageAssets", "/api/assetsGenerate/batchPolishAssetsPrompt"], project("edit", "projectId", [{ table: "o_assets", field: "items", many: true, nestedIdField: "assetsId" }]));
add("POST", ["/api/assetsGenerate/generateAssets"], project("edit", "projectId", [{ table: "o_assets", field: "id" }]));
add("POST", ["/api/assetsGenerate/polishAssetsPrompt"], project("edit", "projectId", [{ table: "o_assets", field: "assetsId" }]));
add("POST", ["/api/cornerScape/batchBindAudio"], project("edit", "projectId"));
add("POST", ["/api/novel/event/generateEvents"], project("edit", "projectId", [{ table: "o_novel", field: "novelIds", many: true }]));
add("POST", ["/api/script/addScript"], project("edit", "projectId", [{ table: "o_assets", field: "assets", many: true, optional: true }]));
add("POST", ["/api/script/extractAssets"], project("edit", "projectId", [{ table: "o_script", field: "scriptIds", many: true }]));
add("POST", ["/api/production/assets/batchGenerateAssetsImage"], project("edit", "projectId", [{ table: "o_script", field: "scriptId" }, { table: "o_assets", field: "assetIds", many: true }]));
add("POST", ["/api/production/storyboard/batchGenerateImage"], project("edit", "projectId", [{ table: "o_script", field: "scriptId" }, { table: "o_storyboard", field: "storyboardIds", many: true }]));
add("POST", ["/api/production/workbench/checkVideoPrompt"], project("read", "projectId", [{ table: "o_script", field: "scriptId" }, { table: "o_videoTrack", field: "trackIds", many: true }]));
add("POST", ["/api/production/workbench/checkVideoStateList"], project("read", "projectId", [{ table: "o_script", field: "scriptId" }, { table: "o_video", field: "videoIds", many: true }]));

add("POST", ["/api/general/getSingleProject"], resource("read", "o_project", "id"));
add("POST", ["/api/general/updateProject", "/api/project/editProject"], resource("edit", "o_project", "id"));
add("POST", ["/api/project/delProject"], { scope: "admin", roles: ["admin"] });
add("POST", ["/api/assets/getImage"], resource("read", "o_assets", "assetsId"));
add("POST", ["/api/assets/pollingImageAssets", "/api/assets/pollingPromptAssets", "/api/cornerScape/pollingAudio"], resource("read", "o_assets", "ids", true));
add("POST", ["/api/production/workbench/getAudioBindAssetsList"], resource("read", "o_assets", "assetsIds", true));
add("POST", ["/api/assets/batchDelete", "/api/assets/delAssets", "/api/assets/delImage"], project("delete", "projectId"));
add("POST", ["/api/assets/updateAssets"], resource("edit", "o_assets", "id"));
add("POST", ["/api/assets/updateAudioAssets", "/api/assets/saveAssets"], project("edit", "projectId", [{ table: "o_assets", field: "id" }]));
add("POST", ["/api/assetsGenerate/cancelGenerate"], resource("edit", "o_image", "id"));
add("POST", ["/api/cornerScape/updateAssetsAudio"], project("edit", "projectId"));
add("POST", ["/api/novel/batchDeleteNovel"], project("delete", "projectId"));
add("POST", ["/api/novel/delNovel", "/api/novel/updateNovel"], resource("edit", "o_novel", "id"));
add("POST", ["/api/novel/getNovelEventState"], resource("read", "o_novel", "ids", true));
add("POST", ["/api/novel/event/batchDeleteEvent", "/api/novel/event/deletEvent"], project("delete", "projectId"));
add("POST", ["/api/production/assets/pollingImage"], resource("read", "o_assets", "ids", true));
add("POST", ["/api/production/assets/deleteAssetsDireve", "/api/production/assets/updateAssetsUrl"], project("edit", "projectId", [{ table: "o_script", field: "scriptId" }, { table: "o_assets", field: "id" }]));
add("POST", ["/api/production/editImage/getImageFlow"], project("read", "projectId", [{ table: "o_script", field: "scriptId" }, { table: "o_imageFlow", field: "id" }]));
add("POST", ["/api/production/editImage/updateImageFlow"], project("edit", "projectId", [{ table: "o_script", field: "scriptId" }, { table: "o_imageFlow", field: "flowId" }]));
add("POST", ["/api/production/editImage/saveImageFlow"], project("edit", "projectId", [{ table: "o_script", field: "scriptId" }]));
add("POST", ["/api/production/storyboard/downPreviewImage", "/api/production/storyboard/previewImage"], resource("read", "o_storyboard", "storyboardIds", true));
add("POST", ["/api/production/storyboard/pollingImage"], resource("read", "o_storyboard", "ids", true));
add("POST", ["/api/production/storyboard/getState"], project("read", "projectId", [{ table: "o_storyboard", field: "id" }]));
add("POST", ["/api/production/storyboard/editStoryboardInfo", "/api/production/storyboard/removeFrame", "/api/production/storyboard/updateStoryboardUrl"], project("edit", "projectId", [{ table: "o_storyboard", field: "id" }]));
add("POST", ["/api/production/storyboard/batchDelete"], project("delete", "projectId", [{ table: "o_storyboard", field: "ids", many: true }]));
add("POST", ["/api/production/storyboard/setLock", "/api/production/storyboard/setReviewState"], project("review", "projectId", [{ table: "o_storyboard", field: "id" }]));
add("POST", ["/api/production/workbench/delVideo"], project("delete", "projectId"));
add("POST", ["/api/production/workbench/updateVideoDuration", "/api/production/workbench/updateVideoPrompt"], resource("edit", "o_videoTrack", "id"));
add("POST", ["/api/production/workbench/deleteTrack"], project("delete", "projectId"));
add("POST", ["/api/production/workbench/selectVideo"], { scope: "project", action: "edit", resources: [{ table: "o_videoTrack", field: "trackId" }, { table: "o_video", field: "videoId" }] });
add("POST", ["/api/script/delScript"], project("delete", "projectId"));
add("POST", ["/api/script/exportScript"], resource("read", "o_script", "id", true));
add("POST", ["/api/script/pollScriptAssets"], resource("read", "o_script", "ids", true));
add("POST", ["/api/script/updateScript"], { scope: "project", action: "edit", resources: [{ table: "o_script", field: "id" }, { table: "o_assets", field: "assets", many: true, optional: true }] });
add("POST", ["/api/script/getAiRegex"], { scope: "team", action: "edit" });
// The task list permits an absent project filter; the handler scopes rows to shared projects.
add("POST", ["/api/task/getTaskApi"], { scope: "team", action: "read" });
add("POST", ["/api/mediaJobs/recover"], project("edit", "projectId"));
// The detail handler resolves legacy/builtin/image/video IDs and authorizes
// the actual stored project after resolving the task source.
add("POST", ["/api/task/taskDetails"], { scope: "team", action: "read" });
add("POST", ["/api/common/getBigImage"], { scope: "media", action: "read" });
add("POST", ["/api/production/workbench/getFileUrl"], { scope: "media", action: "read", mediaItemsField: "items" });
add("POST", ["/api/project/getModelDetails"], { scope: "team", action: "read" });
add("POST", ["/api/builtinAgent/start"], project("edit", "projectId", [{ table: "o_script", field: "scriptId", optional: true }]));
add("POST", ["/api/builtinAgent/list"], project("read", "projectId", [{ table: "o_script", field: "scriptId", optional: true }]));
add("POST", ["/api/builtinAgent/get"], resource("read", "ext_builtin_runs", "runId"));
add("POST", ["/api/builtinAgent/control"], resource("edit", "ext_builtin_runs", "runId"));

// Routes carrying both a project and existing resource IDs must prove that all
// referenced rows belong to that same project. These explicit overrides are
// intentionally kept beside the registry rather than inferred from route names.
add("POST", ["/api/assets/getMaterialData", "/api/production/getStoryboardData", "/api/production/workbench/getGenerateData", "/api/production/workbench/getVideoList"], project("read", "projectId", [{ table: "o_script", field: "scriptId" }]));
add("POST", ["/api/production/getFlowData"], project("read", "projectId", [{ table: "o_script", field: "episodesId" }]));
add("POST", ["/api/production/workbench/getEditTimeline"], project("read", "projectId", [{ table: "o_script", field: "scriptId" }]));
add("POST", ["/api/production/workbench/saveEditTimeline"], project("edit", "projectId", [{ table: "o_script", field: "scriptId" }]));
add("POST", ["/api/production/workbench/generateVideoPrompt"], project("edit", "projectId", [{ table: "o_script", field: "scriptId" }, { table: "o_videoTrack", field: "trackId" }]));
add("POST", ["/api/production/workbench/batchGeneratePrompt"], project("edit", "projectId", [{ table: "o_script", field: "scriptId" }, { table: "o_videoTrack", field: "trackData", many: true, nestedIdField: "trackId" }]));
add("POST", ["/api/production/saveFlowData"], project("edit", "projectId", [{ table: "o_script", field: "episodesId" }]));
add("POST", ["/api/production/editImage/uploadImage", "/api/production/workbench/addTrack", "/api/production/workbench/batchGenerateVideo", "/api/production/workbench/generateVideo"], project("edit", "projectId", [{ table: "o_script", field: "scriptId" }]));
add("POST", ["/api/production/storyboard/addStoryboard", "/api/production/storyboard/batchAddStoryboardInfo"], project("edit", "projectId", [{ table: "o_script", field: "scriptId" }, { table: "o_assets", field: "data", many: true, nestedIdField: "associateAssetsIds", nestedMany: true, optional: true }]));
add("POST", ["/api/production/storyboard/getStoryboardData"], resource("read", "o_script", "scriptId"));
add("POST", ["/api/novel/delNovel"], project("delete", "projectId"));
add("POST", ["/api/novel/updateNovel"], resource("edit", "o_novel", "id"));
add("POST", ["/api/agents/clearMemory"], project("delete"));
add("POST", ["/api/production/assets/deleteAssetsDireve"], project("delete", "projectId", [{ table: "o_script", field: "scriptId" }]));
add("POST", ["/api/production/storyboard/removeFrame"], project("delete", "projectId", [{ table: "o_storyboard", field: "id" }]));

const getOnlyPaths = [
  "/api/setting/agentDeploy/getAgentUseMode", "/api/setting/dbConfig/dbInfo", "/api/setting/dbConfig/exportData",
  "/api/setting/dev/getSwitchAiDevTool", "/api/setting/memoryConfig/getMemory", "/api/setting/modelMap/getPromptList", "/api/test/test",
];
for (const path of getOnlyPaths) delete registry[`POST ${path}`];
add("GET", getOnlyPaths, { scope: "admin", roles: ["admin"] });
delete registry["POST /api/setting/loginConfig/getUser"];
add("GET", ["/api/setting/loginConfig/getUser"], { scope: "team", action: "read" });

export const TEAM_ROUTE_AUTHORIZATION: Readonly<Record<string, RouteAuthorization>> = Object.freeze(registry);

/** Resolve only known current API families; callers must reject undefined. */
export function getRouteAuthorization(method: string, path: string): RouteAuthorization | undefined {
  const key = `${method.toUpperCase()} ${path}`;
  return TEAM_ROUTE_AUTHORIZATION[key];
}

export async function requireAccountAccess(db: Knex, principal: TeamPrincipal, targetId: unknown): Promise<void> {
  const target = Number(targetId);
  if (!Number.isSafeInteger(target) || target <= 0) throw new TeamSecurityError("INVALID_ID", "用户 ID 无效", 400);
  if (principal.role !== "admin" && principal.id !== target) throw new TeamSecurityError("ACCOUNT_FORBIDDEN", "只能访问自己的账户", 403);
  await requireTeamRole(db, principal.id, ["admin", "editor", "viewer"]);
}

export interface RouteAuthorizationDeps {
  db: Knex;
  getProjectId?: (req: Request, spec: RouteAuthorization) => unknown;
  getMedia?: (req: Request) => MediaResource;
}

export function authorizeRoute(deps: RouteAuthorizationDeps, method: string, path: string, principal: TeamPrincipal, req?: Request): Promise<unknown> {
  const spec = getRouteAuthorization(method, path);
  if (!spec) return Promise.reject(new TeamSecurityError("UNKNOWN_OPERATION", "未注册的 API 操作", 403));
  if (spec.scope === "public") return Promise.resolve();
  if (spec.scope === "admin") return requireTeamRole(deps.db, principal.id, spec.roles ?? ["admin"]).then(() => undefined);
  if (spec.scope === "team") {
    const roles = !spec.action || spec.action === "read" ? ["admin", "editor", "viewer"] : spec.action === "delete" || spec.action === "review" ? ["admin"] : ["admin", "editor"];
    return requireTeamRole(deps.db, principal.id, roles as readonly ("admin" | "editor" | "viewer")[]).then(() => principal);
  }
  if (!req) return Promise.reject(new TeamSecurityError("PROJECT_REQUIRED", "项目上下文缺失", 403));
  if (spec.scope === "media") {
    if (spec.mediaItemsField) {
      const items = (req.body as any)?.[spec.mediaItemsField];
      if (!Array.isArray(items) || items.length === 0) return Promise.reject(new TeamSecurityError("MEDIA_CONTEXT_REQUIRED", "媒体资源列表缺失", 403));
      return Promise.all(items.map((item: any) => {
        const table = item?.sources === "storyboard" ? "o_storyboard" : item?.sources === "assets" ? "o_assets" : undefined;
        if (!table) throw new TeamSecurityError("MEDIA_FORBIDDEN", "媒体资源类型未注册", 403);
        return requireMediaAccess(deps.db, principal.id, { table, id: item.id });
      })).then(() => undefined);
    }
    const media = deps.getMedia ? deps.getMedia(req) : { filePath: (req.body as any)?.url };
    return requireMediaAccess(deps.db, principal.id, media).then(() => undefined);
  }
  return authorizeProjectRoute(deps, principal, req, spec);
}

async function authorizeProjectRoute(deps: RouteAuthorizationDeps, principal: TeamPrincipal, req: Request, spec: RouteAuthorization): Promise<unknown> {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const projectIds: number[] = [];
  const direct = spec.projectField ? (deps.getProjectId ? deps.getProjectId(req, spec) : body[spec.projectField]) : undefined;
  if (direct !== undefined && direct !== null) projectIds.push(positiveId(direct));
  for (const selector of spec.resources ?? []) {
    const raw = body[selector.field];
    if ((raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) && selector.optional) continue;
    const values = selector.many ? raw : [raw];
    if (!Array.isArray(values) || values.length === 0) throw new TeamSecurityError("RESOURCE_FORBIDDEN", `资源字段 ${selector.field} 无效`, 403);
    for (const value of values) {
      const extracted = selector.nestedIdField ? (value as any)?.[selector.nestedIdField] : value;
      if (selector.optional && (extracted === undefined || extracted === null || (Array.isArray(extracted) && extracted.length === 0))) continue;
      const ids = selector.nestedMany ? extracted : [extracted];
      if (!Array.isArray(ids)) throw new TeamSecurityError("RESOURCE_FORBIDDEN", `资源字段 ${selector.field} 无效`, 403);
      for (const id of ids) {
        const [pid] = await resolveResourceProjectIds(deps.db, selector.table, id);
        projectIds.push(pid);
      }
    }
  }
  const unique = [...new Set(projectIds)];
  if (unique.length !== 1) throw new TeamSecurityError(unique.length ? "PROJECT_MISMATCH" : "PROJECT_REQUIRED", unique.length ? "请求资源不属于同一项目" : "项目上下文缺失", 403);
  return requireProjectAccess(deps.db, principal.id, unique[0], spec.action ?? "read");
}

/** Global API authorization middleware; mount after session authentication and before routes. */
export function routeAuthorizationMiddleware(deps: RouteAuthorizationDeps) {
  return async (req: Request, res: any, next: (error?: unknown) => void) => {
    try {
      const principal = (req as Request & { teamPrincipal?: TeamPrincipal }).teamPrincipal;
      const path = String(req.originalUrl || req.url || "").split("?", 1)[0];
      const spec = getRouteAuthorization(req.method, path);
      if (spec?.scope !== "public" && !principal) throw new TeamSecurityError("SESSION_REQUIRED", "需要团队会话", 401);
      await authorizeRoute(deps, req.method, path, principal as TeamPrincipal, req);
      next();
    } catch (error) {
      const failure = error instanceof TeamSecurityError ? error : new TeamSecurityError("ACCESS_FAILED", "访问被拒绝", 403);
      res.status(failure.status).send({ code: failure.code, message: failure.message });
    }
  };
}

export interface MediaResource {
  projectId?: unknown;
  table?: "o_image" | "o_storyboard" | "o_video" | "o_assets";
  id?: unknown;
  filePath?: string;
}

export interface ProjectResource {
  projectId?: unknown;
  table?: string;
  id?: unknown;
}

function positiveId(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TeamSecurityError("INVALID_ID", "资源 ID 无效", 400);
  return parsed;
}

async function resolveResourceProjectIds(db: Knex, table: string, value: unknown): Promise<number[]> {
  const knex = db as any;
  if (table === "ext_builtin_runs") {
    if (typeof value !== "string" || !/^[0-9a-f-]{16,64}$/i.test(value)) throw new TeamSecurityError("INVALID_ID", "运行 ID 无效", 400);
    const row = await knex(table).where({ id: value }).select("projectId").first();
    const pid = Number(row?.projectId);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new TeamSecurityError("RESOURCE_FORBIDDEN", "运行未关联项目", 403);
    return [pid];
  }
  const id = positiveId(value);
  let rows: any[];
  switch (table) {
    case "o_project": rows = await knex("o_project").where({ id }).select("id as projectId"); break;
    case "o_image": rows = await knex("o_image").join("o_assets", "o_assets.id", "=", "o_image.assetsId").where("o_image.id", id).select("o_assets.projectId"); break;
    case "o_event": rows = await knex("o_eventChapter").join("o_novel", "o_novel.id", "=", "o_eventChapter.novelId").where("o_eventChapter.eventId", id).distinct("o_novel.projectId"); break;
    case "o_imageFlow": rows = [{ projectId: (await resolveImageFlowOwner(knex, id)).projectId }]; break;
    case "o_tasks": case "o_script": case "o_novel": case "o_assets": case "o_storyboard": case "o_video": case "o_videoTrack": case "o_agentWorkData":
      rows = await knex(table).where({ id }).select("projectId"); break;
    default: throw new TeamSecurityError("RESOURCE_FORBIDDEN", "资源类型未注册", 403);
  }
  const ids = [...new Set(rows.map((row) => Number(row.projectId)).filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  if (ids.length !== 1) throw new TeamSecurityError("RESOURCE_FORBIDDEN", "资源未关联唯一项目", 403);
  return ids;
}

export async function requireProjectResourceAccess(db: Knex, actorId: unknown, resource: ProjectResource, action: ProjectAction): Promise<unknown> {
  if (!resource || typeof resource !== "object") throw new TeamSecurityError("RESOURCE_FORBIDDEN", "资源上下文缺失", 403);
  let pid: number;
  if (resource.table !== undefined || resource.id !== undefined) {
    if (!resource.table || resource.id === undefined) throw new TeamSecurityError("RESOURCE_FORBIDDEN", "资源类型或 ID 缺失", 403);
    [pid] = await resolveResourceProjectIds(db, resource.table, resource.id);
    if (resource.projectId !== undefined && positiveId(resource.projectId) !== pid) throw new TeamSecurityError("PROJECT_MISMATCH", "资源不属于声明的项目", 403);
  } else if (resource.projectId !== undefined) {
    pid = positiveId(resource.projectId);
  } else {
    throw new TeamSecurityError("RESOURCE_FORBIDDEN", "资源未关联可验证项目", 403);
  }
  return requireProjectAccess(db, actorId, pid, action);
}

export async function requireProjectResourcesAccess(db: Knex, actorId: unknown, resource: Omit<ProjectResource, "id"> & { ids: readonly unknown[] }, action: ProjectAction): Promise<unknown> {
  if (!resource.table || !Array.isArray(resource.ids) || resource.ids.length === 0) throw new TeamSecurityError("RESOURCE_FORBIDDEN", "资源列表无效", 403);
  let principal: unknown;
  for (const id of resource.ids) principal = await requireProjectResourceAccess(db, actorId, { projectId: resource.projectId, table: resource.table, id }, action);
  return principal;
}

export async function listAccessibleProjects(db: Knex, actorId: unknown): Promise<unknown[]> {
  await requireTeamRole(db, actorId, ["admin", "editor", "viewer"]);
  return (db as any)("o_project").join("team_projects", "team_projects.project_id", "=", "o_project.id")
    .where("team_projects.team_key", "shared").select("o_project.*").orderBy("o_project.id", "asc");
}

/**
 * Media authorization always resolves a project relation. A path string alone
 * is insufficient, preventing `/oss` from becoming a blanket public trust path.
 */
export interface AuthorizedMedia {
  principal: ProjectAccessPrincipal;
  projectId: number;
  filePath: string;
}

function canonicalMediaPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)) throw new TeamSecurityError("MEDIA_FORBIDDEN", "媒体路径无效", 403);
  let path = value;
  if (path === "/oss" || path.startsWith("/oss/")) path = path.slice(4);
  const relative = path.startsWith("/") ? path.slice(1) : path;
  if (!relative || relative.startsWith("/") || relative.endsWith("/") || relative.includes("//")) throw new TeamSecurityError("MEDIA_FORBIDDEN", "媒体路径无效", 403);
  const parts = relative.split("/");
  if (!parts.length || parts.some((part) => part === "." || part === "..")) throw new TeamSecurityError("MEDIA_FORBIDDEN", "媒体路径无效", 403);
  return "/" + parts.join("/");
}

export async function resolveAuthorizedMedia(db: Knex, actorId: unknown, resource: MediaResource): Promise<AuthorizedMedia> {
  if (!resource || typeof resource !== "object") throw new TeamSecurityError("MEDIA_CONTEXT_REQUIRED", "媒体资源上下文缺失", 403);
  const knex = db as any;
  let rows: { projectId: unknown; filePath: unknown }[] = [];
  if (resource.table && resource.id !== undefined) {
    const id = positiveId(resource.id);
    if (resource.table === "o_image") rows = await knex("o_image").join("o_assets", "o_assets.id", "=", "o_image.assetsId").where("o_image.id", id).select("o_assets.projectId", "o_image.filePath");
    else if (resource.table === "o_assets") rows = await knex("o_assets").join("o_image", "o_image.id", "=", "o_assets.imageId").where("o_assets.id", id).select("o_assets.projectId", "o_image.filePath");
    else rows = await knex(resource.table).where({ id }).select("projectId", "filePath");
  } else if (resource.filePath) {
    const canonical = canonicalMediaPath(resource.filePath);
    const aliases = [canonical, canonical.slice(1)];
    rows = await knex("o_image").join("o_assets", "o_assets.id", "=", "o_image.assetsId").whereIn("o_image.filePath", aliases).select("o_assets.projectId", "o_image.filePath")
      .union(knex("o_storyboard").whereIn("filePath", aliases).select("projectId", "filePath"))
      .union(knex("o_video").whereIn("filePath", aliases).select("projectId", "filePath"));
    // Unselected storyboard/edit-flow results still belong to their project.
    // Include every source before checking uniqueness to reject path aliases
    // shared across projects, including collisions with videos.
    if (await db.schema.hasTable("ext_image_job_bindings")) {
      rows.push(...await knex("ext_image_job_bindings").whereIn("artifactPath", aliases).select("projectId", "artifactPath as filePath"));
    }
    if (await db.schema.hasTable("ext_media_files")) {
      rows.push(...await knex("ext_media_files").whereIn("filePath", aliases).select("projectId", "filePath"));
    }
  } else {
    throw new TeamSecurityError("MEDIA_FORBIDDEN", "媒体资源缺少数据库标识", 403);
  }
  const normalized = rows.filter((row) => typeof row.filePath === "string" && Number.isSafeInteger(Number(row.projectId)) && Number(row.projectId) > 0);
  const projectIds = [...new Set(normalized.map((row) => Number(row.projectId)))];
  if (normalized.length === 0 || projectIds.length !== 1) throw new TeamSecurityError("MEDIA_FORBIDDEN", "媒体资源未关联唯一项目", 403);
  if (resource.projectId !== undefined && positiveId(resource.projectId) !== projectIds[0]) throw new TeamSecurityError("PROJECT_MISMATCH", "媒体资源不属于声明的项目", 403);
  if (resource.filePath !== undefined) {
    const requested = canonicalMediaPath(resource.filePath);
    if (normalized.some((row) => canonicalMediaPath(row.filePath) !== requested)) throw new TeamSecurityError("MEDIA_FORBIDDEN", "媒体路径与数据库记录不符", 403);
  }
  const principal = await requireProjectAccess(db, actorId, projectIds[0], "read");
  return { principal, projectId: projectIds[0], filePath: canonicalMediaPath(normalized[0].filePath) };
}

export async function requireMediaAccess(db: Knex, actorId: unknown, resource: MediaResource): Promise<ProjectAccessPrincipal> {
  return (await resolveAuthorizedMedia(db, actorId, resource)).principal;
}

export function secureMediaPath(resource: MediaResource): string {
  throw new TeamSecurityError("MEDIA_FORBIDDEN", "媒体路径必须先通过数据库授权解析", 403);
}
