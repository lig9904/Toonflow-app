export const builtinAgentTypes = ["scriptAgent", "productionAgent"] as const;
export type BuiltinAgentType = typeof builtinAgentTypes[number];
export const builtinRunStatuses = ["queued", "running", "waiting_human", "paused", "succeeded", "failed", "reconciliation_required", "cancelled"] as const;
export type BuiltinRunStatus = typeof builtinRunStatuses[number];
export type BuiltinControlAction = "pause" | "resume" | "cancel" | "takeover";
export type BuiltinThinkLevel = 0 | 1 | 2 | 3;
export type BuiltinMediaGenerationKind = "image" | "video";
export type BuiltinMediaBudgetMode = "zero_unlimited";

/** Public starts persist this marker so a zero media limit means unlimited for that run. */
export function hasUnlimitedMediaBudget(
  run: Pick<BuiltinRunView, "intent" | "limits">,
  kind: BuiltinMediaGenerationKind,
): boolean {
  if (!run.intent || typeof run.intent !== "object" || Array.isArray(run.intent)) return false;
  if ((run.intent as Record<string, unknown>).mediaBudgetMode !== "zero_unlimited") return false;
  const limit = kind === "image" ? run.limits.maxImageGenerations : run.limits.maxVideoGenerations;
  return limit === 0;
}

/** Checks one media reservation without changing the meaning of legacy zero limits. */
export function isMediaGenerationAllowed(
  run: Pick<BuiltinRunView, "intent" | "limits" | "imageGenerations" | "videoGenerations">,
  kind: BuiltinMediaGenerationKind,
): boolean {
  if (hasUnlimitedMediaBudget(run, kind)) return true;
  const used = kind === "image" ? run.imageGenerations ?? 0 : run.videoGenerations ?? 0;
  const limit = kind === "image" ? run.limits.maxImageGenerations : run.limits.maxVideoGenerations;
  return used < limit;
}

/** New production runs give each model request its own model-level output limit. */
export function hasIndependentProductionOutput(agentType: string, intent: unknown): boolean {
  return agentType === "productionAgent" && !!intent && typeof intent === "object" && !Array.isArray(intent)
    && (intent as Record<string, unknown>).outputBudgetMode === "model_per_call";
}

/** Public starts persist this server-owned preference in intent; older runs default to thinking off. */
export function builtinThinkLevelFromIntent(intent: unknown): BuiltinThinkLevel {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return 0;
  const value = (intent as { thinkLevel?: unknown }).thinkLevel;
  return value === 1 || value === 2 || value === 3 ? value : 0;
}

export interface BuiltinRunLimits {
  maxModelCalls: number;
  maxToolSteps: number;
  maxOutputTokens: number;
  maxImageGenerations: number;
  maxVideoGenerations: number;
}

export const defaultBuiltinRunLimits: BuiltinRunLimits = {
  maxModelCalls: 12,
  maxToolSteps: 40,
  maxOutputTokens: 12000,
  maxImageGenerations: 0,
  maxVideoGenerations: 0,
};

export interface BuiltinRunView {
  id: string;
  agentType: BuiltinAgentType;
  projectId: number | null;
  scriptId: number | null;
  requestedBy: number;
  /** Current human authority; the original creator stays stable for idempotency. */
  executionUserId?: number;
  prompt: string;
  status: BuiltinRunStatus;
  version: number;
  lastSequence: number;
  currentStep: string | null;
  limits: BuiltinRunLimits;
  modelCalls: number;
  toolSteps: number;
  outputTokens?: number;
  imageGenerations?: number;
  videoGenerations?: number;
  createdAt: number;
  updatedAt: number;
  errorCode: string | null;
  errorMessage: string | null;
  result: unknown;
  /** Creative planning generation; media receipts remain independently durable. */
  inputRevision?: number;
  continuation?: string;
  /** Domain entry points and the public start/chat route attach validated intent. */
  intent?: unknown;
}

export interface BuiltinRunEvent {
  runId: string;
  sequence: number;
  type: string;
  data: unknown;
  createdAt: number;
}

export interface CreateBuiltinRun {
  agentType: BuiltinAgentType;
  projectId: number | null;
  scriptId?: number | null;
  requestedBy: number;
  prompt: string;
  idempotencyKey: string;
  limits: BuiltinRunLimits;
  intent?: unknown;
}
