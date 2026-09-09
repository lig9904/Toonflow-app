export const builtinAgentTypes = ["scriptAgent", "productionAgent"] as const;
export type BuiltinAgentType = typeof builtinAgentTypes[number];
export const builtinRunStatuses = ["queued", "running", "waiting_human", "paused", "succeeded", "failed", "reconciliation_required", "cancelled"] as const;
export type BuiltinRunStatus = typeof builtinRunStatuses[number];
export type BuiltinControlAction = "pause" | "resume" | "cancel" | "takeover";

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
  /** Domain entry points attach validated intent; public start/chat cannot set it. */
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
