import type { Knex } from "knex";
import { requireProjectAccess } from "./team";

export type AttachedModelCallDecision =
  | { action: "allow"; actorId: number }
  | { action: "defer"; actorId: number; reason: "run_inactive" }
  | { action: "skip"; actorId?: number; reason: "run_missing" | "run_finished" | "run_changed" | "permission_revoked" | "budget_exceeded" };

/**
 * Reserve one model call for work that belongs to a builtin run but executes in
 * a separate durable worker. The caller must persist its own invocation marker
 * in this same transaction before commit, so a crash can never reserve twice or
 * resend a request whose acceptance is unknown.
 */
export async function reserveAttachedModelCall(trx: Knex.Transaction, input: {
  runId: string;
  projectId: number;
  scriptId?: number | null;
  expectedInputRevision?: number | null;
  expectedActorId?: number | null;
  now?: number;
}): Promise<AttachedModelCallDecision> {
  const run = await trx("ext_builtin_runs").where({ id: input.runId, projectId: input.projectId }).forUpdate().first();
  if (!run) return { action: "skip", reason: "run_missing" };
  const actorId = Number(run.executionUserId ?? run.requestedBy);
  if (!Number.isSafeInteger(actorId) || actorId <= 0) return { action: "skip", reason: "permission_revoked" };
  if (input.expectedActorId != null && Number(input.expectedActorId) !== actorId) return { action: "skip", actorId, reason: "run_changed" };
  if (input.expectedInputRevision != null && Number(run.inputRevision ?? 0) !== Number(input.expectedInputRevision)) return { action: "skip", actorId, reason: "run_changed" };
  if (input.scriptId != null && run.scriptId != null && Number(run.scriptId) !== Number(input.scriptId)) return { action: "skip", actorId, reason: "run_changed" };

  if (["paused", "waiting_human", "queued"].includes(String(run.status))) return { action: "defer", actorId, reason: "run_inactive" };
  if (!["running", "succeeded"].includes(String(run.status))) return { action: "skip", actorId, reason: "run_finished" };
  try {
    await requireProjectAccess(trx, actorId, input.projectId, "edit");
    if (input.scriptId != null && !(await trx("o_script").where({ id: input.scriptId, projectId: input.projectId }).first())) {
      return { action: "skip", actorId, reason: "permission_revoked" };
    }
  } catch {
    return { action: "skip", actorId, reason: "permission_revoked" };
  }

  const limits = typeof run.limits === "string" ? safeJson(run.limits) : run.limits;
  const maxModelCalls = Number(limits?.maxModelCalls);
  if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 0 || Number(run.modelCalls ?? 0) >= maxModelCalls) {
    return { action: "skip", actorId, reason: "budget_exceeded" };
  }
  const now = input.now ?? Date.now();
  const version = Number(run.version ?? 0) + 1;
  const sequence = Number(run.lastSequence ?? 0) + 1;
  const changed = await trx("ext_builtin_runs")
    .where({ id: input.runId, modelCalls: run.modelCalls, version: run.version, lastSequence: run.lastSequence })
    .andWhere("modelCalls", "<", maxModelCalls)
    .update({ modelCalls: trx.raw('"modelCalls" + 1'), version, lastSequence: sequence, updatedAt: now });
  if (changed !== 1) return { action: "skip", actorId, reason: "budget_exceeded" };
  await trx("ext_builtin_run_events").insert({
    runId: input.runId,
    sequence,
    type: "model.attached.reserved",
    data: JSON.stringify({ actorId, projectId: input.projectId, scriptId: input.scriptId ?? null, modelCalls: Number(run.modelCalls ?? 0) + 1, maxModelCalls }),
    createdAt: now,
  });
  return { action: "allow", actorId };
}

function safeJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}
