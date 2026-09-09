import type { Knex } from "knex";
import { z } from "zod";
import { requireProjectAccess, TeamSecurityError } from "../team";
import { listAccessibleProjects } from "../team/authorization";
import {
  artifactFromEvent,
  explicitProjectionKey,
  mapBuiltinTask,
  mapImageTask,
  mapLegacyTask,
  mapVideoTask,
  parseJson,
  type TaskArtifact,
  type TaskSource,
  type UnifiedTask,
} from "./mapper";

export const taskListSchema = z.object({
  projectId: z.number().int().positive().nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  taskClass: z.string().max(100).nullable().optional(),
  source: z.enum(["legacy", "builtin", "image", "video"]).nullable().optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(10),
}).strict();

interface TaskSnapshot {
  tasks: UnifiedTask[];
  eventRows: any[];
}

export type BuiltinTaskControlAction = "pause" | "resume" | "cancel" | "takeover";
export interface BuiltinTaskControlMetadata {
  runId: string;
  version: number;
  status: string;
  allowedActions: BuiltinTaskControlAction[];
}

export function builtinTaskControlMetadata(row: { id: unknown; version: unknown; status: unknown }): BuiltinTaskControlMetadata {
  const status = String(row.status ?? "");
  const allowedActions: BuiltinTaskControlAction[] = status === "queued" || status === "running"
    ? ["pause", "cancel", "takeover"]
    : status === "paused" || status === "waiting_human"
      ? ["resume", "cancel", "takeover"]
      : [];
  return { runId: String(row.id), version: Number(row.version), status, allowedActions };
}

export async function getTaskProjectOptions(db: Knex, userId: number): Promise<Array<{ id: number; name: string }>> {
  const projects = await listAccessibleProjects(db, userId) as Array<{ id: number; name?: string }>;
  return projects.map((project) => ({ id: Number(project.id), name: project.name ?? "" }));
}

async function existingTables(db: Knex): Promise<Record<string, boolean>> {
  const names = ["o_tasks", "ext_builtin_runs", "ext_builtin_run_events", "ext_image_jobs", "ext_image_job_bindings", "ext_video_jobs"];
  const values = await Promise.all(names.map((name) => db.schema.hasTable(name)));
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

function eventData(row: any): any {
  return parseJson(row.data) ?? {};
}

function runIdFromVideo(row: any, knownRunIds: Set<string>, eventRunByJob: Map<number, string>): string | null {
  const eventRun = eventRunByJob.get(Number(row.id));
  if (eventRun && knownRunIds.has(eventRun)) return eventRun;
  const match = String(row.idempotencyKey ?? "").match(/^builtin:([0-9a-f]{8}-[0-9a-f-]{27}):/i);
  return match && knownRunIds.has(match[1]) ? match[1] : null;
}

function removeExplicitLegacyProjections(legacyRows: any[], realTaskIds: Set<string>): any[] {
  return legacyRows.filter((row) => {
    const projected = explicitProjectionKey(row);
    return projected == null || !realTaskIds.has(projected);
  });
}

async function buildTaskSnapshot(db: Knex, userId: number, projectFilter?: number | null): Promise<TaskSnapshot> {
  const projectOptions = await getTaskProjectOptions(db, userId);
  const accessibleIds = projectOptions.map((project) => project.id);
  if (projectFilter != null && !accessibleIds.includes(projectFilter)) throw new TeamSecurityError("PROJECT_FORBIDDEN", "无权读取该项目的任务", 403);
  const projectIds = projectFilter == null ? accessibleIds : [projectFilter];
  if (!projectIds.length) return { tasks: [], eventRows: [] };
  const names = new Map(projectOptions.map((project) => [project.id, project.name]));
  const tables = await existingTables(db);

  const [legacyRows, builtinRows, imageRows, imageBindings, videoRows, eventRows] = await Promise.all([
    tables.o_tasks ? db("o_tasks").whereIn("projectId", projectIds).select("*") : [],
    tables.ext_builtin_runs ? db("ext_builtin_runs").whereIn("projectId", projectIds).select("*") : [],
    tables.ext_image_jobs ? db("ext_image_jobs").whereIn("projectId", projectIds).select("*") : [],
    tables.ext_image_job_bindings ? db("ext_image_job_bindings").whereIn("projectId", projectIds).select("*") : [],
    tables.ext_video_jobs ? db("ext_video_jobs").whereIn("projectId", projectIds).select("*") : [],
    tables.ext_builtin_run_events && tables.ext_builtin_runs
      ? db("ext_builtin_run_events as event")
        .join("ext_builtin_runs as run", "run.id", "event.runId")
        .whereIn("run.projectId", projectIds)
        .whereIn("event.type", ["media.reserved", "artifact.saved", "run.error", "run.status"])
        .select("event.*")
      : [],
  ]);

  const runIds = new Set(builtinRows.map((row: any) => String(row.id)));
  const artifactsByRun = new Map<string, TaskArtifact[]>();
  const eventImageRun = new Map<number, string>();
  const eventVideoRun = new Map<number, string>();
  for (const event of eventRows) {
    const runId = String(event.runId);
    const data = eventData(event);
    if (Number.isSafeInteger(Number(data.jobId))) {
      if (data.kind === "image") eventImageRun.set(Number(data.jobId), runId);
      if (data.kind === "video") eventVideoRun.set(Number(data.jobId), runId);
    }
    if (event.type === "artifact.saved") {
      const artifact = artifactFromEvent(event);
      if (artifact) artifactsByRun.set(runId, [...(artifactsByRun.get(runId) ?? []), artifact]);
    }
  }

  const bindingByJob = new Map(imageBindings.map((row: any) => [Number(row.jobId), row]));
  const imageParent = new Map<number, string>();
  for (const row of imageRows) {
    const binding = bindingByJob.get(Number(row.id));
    const runId = binding?.runId == null ? eventImageRun.get(Number(row.id)) : String(binding.runId);
    if (runId && runIds.has(runId)) imageParent.set(Number(row.id), `builtin:${runId}`);
  }
  const videoParent = new Map<number, string>();
  for (const row of videoRows) {
    const runId = runIdFromVideo(row, runIds, eventVideoRun);
    if (runId) videoParent.set(Number(row.id), `builtin:${runId}`);
  }

  const builtinTasks = builtinRows.map((row: any) => mapBuiltinTask(row, names, artifactsByRun.get(String(row.id)) ?? []));
  const imageTasks = imageRows.map((row: any) => mapImageTask(row, names, bindingByJob.get(Number(row.id)), imageParent.get(Number(row.id))));
  const videoTasks = videoRows.map((row: any) => mapVideoTask(row, names, videoParent.get(Number(row.id))));
  const realIds = new Set([...builtinTasks, ...imageTasks, ...videoTasks].map((task) => task.id));
  const legacyTasks = removeExplicitLegacyProjections(legacyRows, realIds).map((row: any) => mapLegacyTask(row, names));
  const tasks = [...legacyTasks, ...builtinTasks, ...imageTasks, ...videoTasks]
    .sort((left, right) => right.startTime - left.startTime || right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
  return { tasks, eventRows };
}

export async function readTaskList(db: Knex, userId: number, raw: z.input<typeof taskListSchema>) {
  const input = taskListSchema.parse(raw);
  const snapshot = await buildTaskSnapshot(db, userId, input.projectId);
  const filtered = snapshot.tasks.filter((task) => (!input.state || task.state === input.state)
    && (!input.taskClass || task.taskClass === input.taskClass)
    && (!input.source || task.source === input.source));
  const start = (input.page - 1) * input.limit;
  return { data: filtered.slice(start, start + input.limit), total: filtered.length };
}

export async function readTaskCategories(db: Knex, userId: number) {
  const snapshot = await buildTaskSnapshot(db, userId);
  return [...new Set(snapshot.tasks.map((task) => task.taskClass).filter(Boolean))].sort().map((taskClass) => ({ taskClass }));
}

function normalizeTaskId(taskId: unknown): string {
  if (typeof taskId === "number" && Number.isSafeInteger(taskId) && taskId > 0) return `legacy:${taskId}`;
  if (typeof taskId !== "string" || !/^(legacy:[1-9]\d*|(?:image|video):[1-9]\d*|builtin:[0-9a-f]{8}-[0-9a-f-]{27})$/i.test(taskId)) {
    throw new TeamSecurityError("INVALID_TASK_ID", "任务 ID 无效", 400);
  }
  return taskId.toLowerCase();
}

export async function readTaskDetail(db: Knex, userId: number, taskIdInput: unknown) {
  const taskId = normalizeTaskId(taskIdInput);
  const snapshot = await buildTaskSnapshot(db, userId);
  const task = snapshot.tasks.find((item) => item.id.toLowerCase() === taskId);
  if (!task) throw new TeamSecurityError("TASK_NOT_FOUND", "任务不存在", 404);
  await requireProjectAccess(db, userId, task.projectId, "read");
  const relatedTasks = task.source === "builtin"
    ? snapshot.tasks.filter((item) => item.parentTaskId === task.id)
    : task.parentTaskId ? snapshot.tasks.filter((item) => item.id === task.parentTaskId) : [];
  const events = task.source === "builtin"
    ? snapshot.eventRows.filter((row) => String(row.runId) === String(task.sourceId)).sort((a, b) => Number(a.sequence) - Number(b.sequence)).map((row) => ({ sequence: Number(row.sequence), type: String(row.type), data: eventData(row), createdAt: Number(row.createdAt) }))
    : [];
  let control: BuiltinTaskControlMetadata | undefined;
  if (task.source === "builtin") {
    try {
      await requireProjectAccess(db, userId, task.projectId, "edit");
      const run = await db("ext_builtin_runs").where({ id: String(task.sourceId), projectId: task.projectId }).select("id", "version", "status").first();
      if (!run) throw new TeamSecurityError("TASK_NOT_FOUND", "运行不存在", 404);
      control = builtinTaskControlMetadata(run);
    } catch (error) {
      if (!(error instanceof TeamSecurityError) || error.code === "TASK_NOT_FOUND") throw error;
    }
  }
  return { ...task, relatedTasks, events, ...(control ? { control } : {}) };
}

export async function readProjectStatistics(db: Knex, userId: number, projectId: number) {
  await requireProjectAccess(db, userId, projectId, "read");
  const [roles, scripts, videos, boards] = await Promise.all([
    db("o_assets").where({ projectId }).whereIn("type", ["role", "角色"]).whereNull("assetsId").count("id as total").first(),
    db("o_script").where({ projectId }).count("id as total").first(),
    db("o_video").where({ projectId }).count("id as total").first(),
    db("o_storyboard").where({ projectId }).count("id as total").first(),
  ]);
  return { roleCount: Number(roles?.total ?? 0), scriptCount: Number(scripts?.total ?? 0), videoCount: Number(videos?.total ?? 0), storyboardCount: Number(boards?.total ?? 0) };
}

export type { TaskSource, UnifiedTask } from "./mapper";
