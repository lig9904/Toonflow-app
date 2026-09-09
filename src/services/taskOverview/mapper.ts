export type TaskSource = "legacy" | "builtin" | "image" | "video";

export interface TaskArtifact {
  kind: string;
  path: string;
  jobId?: number;
  targetKind?: string;
  targetId?: string | number;
  selected?: boolean;
}

export interface UnifiedTask {
  id: string;
  source: TaskSource;
  sourceId: string | number;
  sourceLabel: string;
  projectId: number;
  projectName: string;
  scriptId: number | null;
  taskClass: string;
  relatedObjects: string;
  model: string;
  describe: string;
  state: string;
  startTime: number;
  updatedAt: number;
  reason: string;
  waitingQuestion: string | null;
  progress: { current: number; total: number | null; phase: string };
  artifacts: TaskArtifact[];
  parentTaskId: string | null;
}

export function parseJson<T = any>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value !== "string") return value as T;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function projectName(row: any, names: Map<number, string>): string {
  return names.get(integer(row.projectId)) ?? "";
}

export function mapLegacyTask(row: any, names: Map<number, string>): UnifiedTask {
  const id = integer(row.id);
  return {
    id: `legacy:${id}`,
    source: "legacy",
    sourceId: id,
    sourceLabel: "旧任务",
    projectId: integer(row.projectId),
    projectName: projectName(row, names),
    scriptId: null,
    taskClass: String(row.taskClass ?? "旧任务"),
    relatedObjects: String(row.relatedObjects ?? ""),
    model: String(row.model ?? ""),
    describe: String(row.describe ?? ""),
    state: String(row.state ?? "进行中"),
    startTime: integer(row.startTime),
    updatedAt: integer(row.startTime),
    reason: String(row.reason ?? ""),
    waitingQuestion: null,
    progress: { current: row.state === "已完成" ? 1 : 0, total: 1, phase: String(row.state ?? "进行中") },
    artifacts: [],
    parentTaskId: null,
  };
}

const builtinStates: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  waiting_human: "待人工",
  paused: "已暂停",
  succeeded: "已完成",
  failed: "生成失败",
  reconciliation_required: "待核对",
  cancelled: "已取消",
};

export function mapBuiltinTask(row: any, names: Map<number, string>, artifacts: TaskArtifact[] = []): UnifiedTask {
  const id = String(row.id);
  const intent = parseJson<{ phase?: string }>(row.intent);
  const model = intent?.phase === "matchAudio"
    ? "角色音色匹配"
    : intent?.phase === "novelEvents"
      ? "原文事件提取"
      : row.agentType === "scriptAgent" ? "剧本 Agent" : "制作 Agent";
  return {
    id: `builtin:${id}`,
    source: "builtin",
    sourceId: id,
    sourceLabel: "内置 Agent",
    projectId: integer(row.projectId),
    projectName: projectName(row, names),
    scriptId: row.scriptId == null ? null : integer(row.scriptId),
    taskClass: "内置 Agent",
    relatedObjects: row.scriptId == null ? "项目工作区" : `剧集 #${integer(row.scriptId)}`,
    model,
    describe: String(row.prompt ?? ""),
    state: builtinStates[String(row.status)] ?? String(row.status ?? ""),
    startTime: integer(row.createdAt),
    updatedAt: integer(row.updatedAt),
    reason: String(row.errorMessage ?? ""),
    waitingQuestion: row.waitingQuestion == null ? null : String(row.waitingQuestion),
    // Tool-call limits are safety ceilings, not completion percentages.
    progress: { current: integer(row.toolSteps), total: null, phase: String(row.currentStep ?? row.status ?? "") },
    artifacts,
    parentTaskId: null,
  };
}

const jobStates: Record<string, string> = {
  RESERVED: "排队中",
  SUBMITTING: "提交中",
  SUBMITTED: "进行中",
  POLLING: "进行中",
  DOWNLOADING: "保存中",
  SUCCEEDED: "已完成",
  FAILED: "生成失败",
  RECONCILIATION_REQUIRED: "待核对",
};

function promptFromPayload(row: any): string {
  const payload = parseJson<any>(row.payload);
  return typeof payload?.config?.prompt === "string" ? payload.config.prompt : "";
}

export function mapImageTask(row: any, names: Map<number, string>, binding?: any, parentTaskId?: string | null): UnifiedTask {
  const id = integer(row.id);
  const target = binding ? `${String(binding.targetKind)} #${String(binding.targetId)}` : "图片产物";
  const artifactPath = binding?.artifactPath ?? (row.status === "SUCCEEDED" ? row.outputPath : null);
  return {
    id: `image:${id}`,
    source: "image",
    sourceId: id,
    sourceLabel: "图片任务",
    projectId: integer(row.projectId),
    projectName: projectName(row, names),
    scriptId: binding?.scriptId == null ? null : integer(binding.scriptId),
    taskClass: "图像生成",
    relatedObjects: target,
    model: String(row.modelKey ?? ""),
    describe: promptFromPayload(row),
    state: jobStates[String(row.status)] ?? String(row.status ?? ""),
    startTime: integer(row.createdAt),
    updatedAt: integer(row.updatedAt),
    reason: String(row.lastError ?? binding?.error ?? ""),
    waitingQuestion: null,
    progress: { current: integer(row.pollAttempts) + integer(row.queryFailures) + integer(row.downloadFailures), total: null, phase: String(row.status ?? "") },
    artifacts: artifactPath ? [{ kind: "image", path: String(artifactPath), jobId: id, targetKind: binding?.targetKind, targetId: binding?.targetId, selected: Boolean(binding?.selected) }] : [],
    parentTaskId: parentTaskId ?? null,
  };
}

export function mapVideoTask(row: any, names: Map<number, string>, parentTaskId?: string | null): UnifiedTask {
  const id = integer(row.id);
  const artifactPath = row.status === "SUCCEEDED" ? row.outputPath : null;
  return {
    id: `video:${id}`,
    source: "video",
    sourceId: id,
    sourceLabel: "视频任务",
    projectId: integer(row.projectId),
    projectName: projectName(row, names),
    scriptId: integer(row.scriptId),
    taskClass: "视频生成",
    relatedObjects: `轨道 #${integer(row.trackId)}`,
    model: String(row.modelKey ?? ""),
    describe: promptFromPayload(row),
    state: jobStates[String(row.status)] ?? String(row.status ?? ""),
    startTime: integer(row.createdAt),
    updatedAt: integer(row.updatedAt),
    reason: String(row.lastError ?? ""),
    waitingQuestion: null,
    progress: { current: integer(row.pollAttempts) + integer(row.queryFailures) + integer(row.downloadFailures), total: null, phase: String(row.status ?? "") },
    artifacts: artifactPath ? [{ kind: "video", path: String(artifactPath), jobId: id, targetKind: "track", targetId: integer(row.trackId), selected: false }] : [],
    parentTaskId: parentTaskId ?? null,
  };
}

export function artifactFromEvent(row: any): TaskArtifact | null {
  const data = parseJson<any>(row.data);
  const path = data?.path ?? data?.artifactPath;
  if (typeof path !== "string" || !path) return null;
  return { kind: String(data?.kind ?? "artifact"), path, ...(Number.isSafeInteger(Number(data?.jobId)) ? { jobId: Number(data.jobId) } : {}), ...(data?.targetKind ? { targetKind: String(data.targetKind) } : {}), ...(data?.targetId != null ? { targetId: data.targetId } : {}), ...(data?.selected != null ? { selected: Boolean(data.selected) } : {}) };
}

export function explicitProjectionKey(row: any): string | null {
  const value = parseJson<any>(row.relatedObjects);
  if (!value || typeof value !== "object") return null;
  if (typeof value.sourceTaskId === "string" && /^(legacy|builtin|image|video):/.test(value.sourceTaskId)) return value.sourceTaskId;
  if (typeof value.builtinRunId === "string") return `builtin:${value.builtinRunId}`;
  if (typeof value.runId === "string") return `builtin:${value.runId}`;
  if (Number.isSafeInteger(Number(value.imageJobId))) return `image:${Number(value.imageJobId)}`;
  if (Number.isSafeInteger(Number(value.videoJobId))) return `video:${Number(value.videoJobId)}`;
  if (["builtin", "image", "video"].includes(value.source) && (typeof value.sourceId === "string" || Number.isSafeInteger(Number(value.sourceId)))) return `${value.source}:${value.sourceId}`;
  return null;
}
