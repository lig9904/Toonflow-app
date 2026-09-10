import type { Knex } from "knex";

/** End legacy production handoffs without scheduling or replaying any provider call. */
export async function finishLegacyProductionWaits(db: Knex): Promise<number> {
  if (!(await db.schema.hasTable("ext_builtin_runs"))) return 0;
  return db.transaction(async (trx) => {
    await trx.raw("SET LOCAL lock_timeout = '5s'");
    const rows = await trx("ext_builtin_runs").where({ agentType: "productionAgent", status: "waiting_human" }).forUpdate();
    for (const row of rows) {
      const data = typeof row.waitingData === "string" ? JSON.parse(row.waitingData) : row.waitingData;
      const completed = Array.isArray(data?.completed) ? data.completed : [];
      const hasOutput = completed.some((entry: any) => entry?.result?.status === "succeeded" && entry.result.artifactPath);
      const savedEvents = await trx("ext_builtin_run_events").where({ runId: row.id, type: "artifact.saved" }).select("data");
      const hasSavedWork = hasOutput || savedEvents.some((event: any) => {
        const value = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        return ["productionPlanning", "storyboards", "assets"].includes(value?.kind) || typeof value?.path === "string";
      });
      const status = hasSavedWork ? "succeeded" : "failed";
      const message = hasOutput ? "本次生成已结束，图片已保存；可直接查看生成图或在画布调整。" : "该历史任务未执行完成，已结束；调整画布或配置后可发起新任务。";
      const result = {
        projectId: Number(row.projectId), scriptId: row.scriptId == null ? null : Number(row.scriptId),
        actions: data?.action ? [data.action] : [], outcome: hasOutput && Array.isArray(data?.issues) && data.issues.every((issue: any) => issue.result?.status === "succeeded") ? "complete_with_notes" : hasSavedWork ? "partial" : "not_executed",
        ...(data?.action ? { [data.action]: completed } : {}),
        issues: [{ message }], previousWait: { question: row.waitingQuestion, data },
      };
      const now = Date.now(), version = Number(row.version) + 1, sequence = Number(row.lastSequence);
      await trx("ext_builtin_run_steps").where({ runId: row.id, status: "started", imageGeneration: true }).whereRaw("result->>'status' = 'succeeded'")
        .update({ status: "completed", completedAt: now, updatedAt: now });
      await trx("ext_builtin_runs").where({ id: row.id, status: "waiting_human" }).update({
        status, version, result: JSON.stringify(result), waitingQuestion: null, waitingData: null,
        currentStep: null, leaseOwner: null, leaseUntil: null, leaseEpoch: Number(row.leaseEpoch) + 1,
        errorCode: hasSavedWork ? null : "INVALID_INPUT", errorMessage: hasSavedWork ? null : message,
        lastSequence: sequence + 2, updatedAt: now,
      });
      await trx("ext_builtin_run_events").insert([
        { runId: row.id, sequence: sequence + 1, type: "message.completed", data: JSON.stringify({ text: message }), createdAt: now },
        { runId: row.id, sequence: sequence + 2, type: "run.status", data: JSON.stringify({ status, reason: "production_handoff_removed" }), createdAt: now },
      ]);
    }
    return rows.length;
  });
}
