import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { isPostgres } from "../lib/dbTransaction";
import {
  syncVolcengineAssetGroupCreation,
  syncVolcengineAssetUpload,
  type VolcengineAssetUploadRuntime,
} from "./volcengineTrustedAssetUploads";
import type { VolcengineTrustedAssetClient } from "./volcengineTrustedAssets";

const RECOVERY = "ext_volcengine_asset_recovery";
const GROUP_OPERATIONS = "ext_volcengine_group_creations";
const UPLOAD_OPERATIONS = "ext_volcengine_asset_uploads";
const UNKNOWN_DEADLINE_MS = 6 * 60 * 60 * 1000;
const PROCESSING_DEADLINE_MS = 48 * 60 * 60 * 1000;
const LEASE_MS = 2 * 60_000;
const ABANDONED_PREPARED_MS = 2 * 60_000;

type RecoveryKind = "group" | "asset";
type StopReason = "permission_revoked" | "deadline_exceeded";

export interface VolcengineUploadRecoveryAuthorization {
  actorId: string;
  projectId: number;
  action: "edit";
}

export interface VolcengineUploadRecoveryDependencies {
  db: Knex;
  client: () => Promise<VolcengineTrustedAssetClient>;
  runtime: () => VolcengineAssetUploadRuntime;
  authorize: (request: VolcengineUploadRecoveryAuthorization) => Promise<boolean>;
  now?: () => number;
  scanIntervalMs?: number;
  maxConcurrency?: number;
  unknownDeadlineMs?: number;
  processingDeadlineMs?: number;
}

export interface VolcengineUploadRecoveryState {
  kind: RecoveryKind;
  operationId: string;
  projectId: number;
  attempts: number;
  nextAttemptAt: number;
  deadlineAt: number;
  stoppedReason: StopReason | null;
  lastError: string | null;
  updatedAt: number;
}

function stateView(row: any): VolcengineUploadRecoveryState {
  return {
    kind: row.kind, operationId: String(row.operationId), projectId: Number(row.projectId), attempts: Number(row.attempts), nextAttemptAt: Number(row.nextAttemptAt), deadlineAt: Number(row.deadlineAt),
    stoppedReason: row.stoppedReason ?? null, lastError: row.lastError ?? null, updatedAt: Number(row.updatedAt),
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "素材库后台恢复失败";
  return message.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]").slice(0, 500);
}

function retryDelay(kind: RecoveryKind, sourceStatus: string, attempts: number): number {
  if (kind === "group" || sourceStatus === "submission_unknown") return Math.min(15 * 60_000, 30_000 * (2 ** Math.min(attempts, 5)));
  return Math.min(2 * 60_000, 15_000 * (2 ** Math.min(attempts, 3)));
}

export async function ensureVolcengineUploadRecoverySchema(db: Knex): Promise<void> {
  await db.transaction(async (trx) => {
    if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", ["toonflow:volcengine-upload-recovery-schema"]);
    if (!(await trx.schema.hasTable(RECOVERY))) await trx.schema.createTable(RECOVERY, (table) => {
      table.text("kind").notNullable(); table.text("operationId").notNullable(); table.bigInteger("projectId").notNullable(); table.text("actorId").notNullable(); table.integer("attempts").notNullable().defaultTo(0);
      table.bigInteger("nextAttemptAt").notNullable(); table.bigInteger("deadlineAt").notNullable(); table.text("leaseOwner").nullable(); table.bigInteger("leaseUntil").nullable(); table.text("stoppedReason").nullable(); table.text("lastError").nullable();
      table.bigInteger("createdAt").notNullable(); table.bigInteger("updatedAt").notNullable(); table.primary(["kind", "operationId"]); table.index(["nextAttemptAt", "leaseUntil"]);
    });
  });
}

async function discover(dependencies: VolcengineUploadRecoveryDependencies, now: number): Promise<void> {
  const { db } = dependencies;
  const candidates: Array<{ kind: RecoveryKind; operationId: string; projectId: number; actorId: string; deadlineAt: number }> = [];
  if (await db.schema.hasTable(GROUP_OPERATIONS)) {
    await db(GROUP_OPERATIONS).where({ status: "prepared" }).whereNull("error").where("updatedAt", "<", now - ABANDONED_PREPARED_MS).update({ status: "rejected", updatedAt: now, error: JSON.stringify({ code: "RECOVERY_NOT_SUBMITTED", message: "素材组创建尚未提交到火山，可重新发起创建" }) });
    const rows = await db(GROUP_OPERATIONS).where({ status: "submission_unknown" }).select("operationId", "projectId", "actorId", "createdAt");
    for (const row of rows) candidates.push({ kind: "group", operationId: String(row.operationId), projectId: Number(row.projectId), actorId: String(row.actorId), deadlineAt: Number(row.createdAt) + (dependencies.unknownDeadlineMs ?? UNKNOWN_DEADLINE_MS) });
  }
  if (await db.schema.hasTable(UPLOAD_OPERATIONS)) {
    await db(UPLOAD_OPERATIONS).where({ status: "prepared" }).whereNull("error").where("updatedAt", "<", now - ABANDONED_PREPARED_MS).update({ status: "rejected", updatedAt: now, error: JSON.stringify({ code: "RECOVERY_NOT_SUBMITTED", message: "素材尚未提交到火山，可重新发起上传" }) });
    const rows = await db(UPLOAD_OPERATIONS).where((query) => query.whereIn("status", ["submission_unknown", "processing"]).orWhere((nested) => nested.where({ status: "active", bindStatus: "pending" }))).select("operationId", "projectId", "actorId", "status", "createdAt");
    for (const row of rows) candidates.push({ kind: "asset", operationId: String(row.operationId), projectId: Number(row.projectId), actorId: String(row.actorId), deadlineAt: Number(row.createdAt) + (row.status === "submission_unknown" ? dependencies.unknownDeadlineMs ?? UNKNOWN_DEADLINE_MS : dependencies.processingDeadlineMs ?? PROCESSING_DEADLINE_MS) });
  }
  if (!candidates.length) return;
  await db(RECOVERY).insert(candidates.map((item) => ({ ...item, attempts: 0, nextAttemptAt: now, leaseOwner: null, leaseUntil: null, stoppedReason: null, lastError: null, createdAt: now, updatedAt: now }))).onConflict(["kind", "operationId"]).ignore();
}

async function sourceRow(db: Knex, kind: RecoveryKind, operationId: string): Promise<any | undefined> {
  return db(kind === "group" ? GROUP_OPERATIONS : UPLOAD_OPERATIONS).where({ operationId }).first();
}

function isPending(kind: RecoveryKind, row: any): boolean {
  if (!row) return false;
  if (kind === "group") return row.status === "submission_unknown";
  return row.status === "submission_unknown" || row.status === "processing" || (row.status === "active" && row.bindStatus === "pending");
}

async function markStopped(db: Knex, recovery: any, reason: StopReason, now: number): Promise<void> {
  const message = reason === "permission_revoked" ? "原操作人已无项目编辑权限，后台恢复已停止" : "后台恢复已超过安全期限，未继续请求火山素材库";
  await db.transaction(async (trx) => {
    await trx(RECOVERY).where({ kind: recovery.kind, operationId: recovery.operationId, leaseOwner: recovery.leaseOwner }).update({ stoppedReason: reason, leaseOwner: null, leaseUntil: null, lastError: message, updatedAt: now });
    const table = recovery.kind === "group" ? GROUP_OPERATIONS : UPLOAD_OPERATIONS;
    await trx(table).where({ operationId: recovery.operationId }).update({ error: JSON.stringify({ code: reason === "permission_revoked" ? "PERMISSION_REVOKED" : "RECOVERY_DEADLINE_EXCEEDED", message }), updatedAt: now });
  });
}

async function processClaim(dependencies: VolcengineUploadRecoveryDependencies, recovery: any, owner: string): Promise<void> {
  const now = dependencies.now?.() ?? Date.now(), { db } = dependencies;
  const claimed = await db(RECOVERY).where({ kind: recovery.kind, operationId: recovery.operationId }).whereNull("stoppedReason").where("nextAttemptAt", "<=", now)
    .where((query) => query.whereNull("leaseUntil").orWhere("leaseUntil", "<", now)).update({ leaseOwner: owner, leaseUntil: now + LEASE_MS, updatedAt: now });
  if (!Number(claimed)) return;
  const locked = await db(RECOVERY).where({ kind: recovery.kind, operationId: recovery.operationId, leaseOwner: owner }).first();
  if (!locked) return;
  const source = await sourceRow(db, locked.kind, locked.operationId);
  if (!isPending(locked.kind, source)) { await db(RECOVERY).where({ kind: locked.kind, operationId: locked.operationId, leaseOwner: owner }).delete(); return; }
  if (now >= Number(locked.deadlineAt)) { await markStopped(db, locked, "deadline_exceeded", now); return; }
  let allowed: boolean;
  try { allowed = await dependencies.authorize({ actorId: String(locked.actorId), projectId: Number(locked.projectId), action: "edit" }); }
  catch (error) {
    const attempts = Number(locked.attempts) + 1;
    await db(RECOVERY).where({ kind: locked.kind, operationId: locked.operationId, leaseOwner: owner }).update({ attempts, nextAttemptAt: now + retryDelay(locked.kind, source.status, attempts), leaseOwner: null, leaseUntil: null, lastError: safeError(error), updatedAt: now });
    return;
  }
  if (!allowed) { await markStopped(db, locked, "permission_revoked", now); return; }
  try {
    const client = await dependencies.client();
    const result = locked.kind === "group"
      ? await syncVolcengineAssetGroupCreation(db, client, { projectId: Number(locked.projectId), operationId: locked.operationId })
      : await syncVolcengineAssetUpload(db, client, { projectId: Number(locked.projectId), operationId: locked.operationId }, dependencies.runtime());
    const pending = locked.kind === "group" ? result.status === "submission_unknown" : result.status === "submission_unknown" || result.status === "processing" || (result.status === "active" && result.bindStatus === "pending");
    if (!pending) { await db(RECOVERY).where({ kind: locked.kind, operationId: locked.operationId, leaseOwner: owner }).delete(); return; }
    const attempts = Number(locked.attempts) + 1;
    const extendedDeadline = locked.kind === "asset" && result.status === "processing" ? Math.max(Number(locked.deadlineAt), Number(source.createdAt) + (dependencies.processingDeadlineMs ?? PROCESSING_DEADLINE_MS)) : Number(locked.deadlineAt);
    await db(RECOVERY).where({ kind: locked.kind, operationId: locked.operationId, leaseOwner: owner }).update({ attempts, nextAttemptAt: now + retryDelay(locked.kind, result.status, attempts), deadlineAt: extendedDeadline, leaseOwner: null, leaseUntil: null, lastError: result.error?.message ?? null, updatedAt: now });
  } catch (error) {
    const attempts = Number(locked.attempts) + 1;
    await db(RECOVERY).where({ kind: locked.kind, operationId: locked.operationId, leaseOwner: owner }).update({ attempts, nextAttemptAt: now + retryDelay(locked.kind, source.status, attempts), leaseOwner: null, leaseUntil: null, lastError: safeError(error), updatedAt: now });
  }
}

async function concurrent<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (cursor < items.length) { const item = items[cursor++]; await work(item); } }));
}

export function createVolcengineTrustedAssetUploadRecovery(dependencies: VolcengineUploadRecoveryDependencies) {
  const owner = `recovery:${randomUUID()}`;
  const maxConcurrency = Math.max(1, Math.min(2, dependencies.maxConcurrency ?? 2));
  const intervalMs = Math.max(10_000, dependencies.scanIntervalMs ?? 30_000);
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  const runOnce = (): Promise<void> => {
    if (active) return active;
    active = (async () => {
      const now = dependencies.now?.() ?? Date.now(); await ensureVolcengineUploadRecoverySchema(dependencies.db); await discover(dependencies, now);
      const due = await dependencies.db(RECOVERY).whereNull("stoppedReason").where("nextAttemptAt", "<=", now).where((query) => query.whereNull("leaseUntil").orWhere("leaseUntil", "<", now)).orderBy("nextAttemptAt").limit(100);
      await concurrent(due, maxConcurrency, (row) => processClaim(dependencies, row, owner));
    })().finally(() => { active = undefined; });
    return active;
  };
  return {
    runOnce,
    start() { if (timer) return; const scan = () => { void runOnce().catch((error) => console.error("[trustedAssets] recovery scan failed", error instanceof Error ? error.name : "UnknownError")); }; scan(); timer = setInterval(scan, intervalMs); timer.unref?.(); },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
    async kick(input: { kind: RecoveryKind; operationId: string; resumeStopped?: boolean }) {
      await ensureVolcengineUploadRecoverySchema(dependencies.db); const now = dependencies.now?.() ?? Date.now(); await discover(dependencies, now);
      const update: Record<string, unknown> = { nextAttemptAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now }; if (input.resumeStopped) update.stoppedReason = null;
      await dependencies.db(RECOVERY).where({ kind: input.kind, operationId: input.operationId }).where((query) => query.whereNull("leaseUntil").orWhere("leaseUntil", "<=", now)).update(update); return runOnce();
    },
    async getState(input: { kind: RecoveryKind; operationId: string }): Promise<VolcengineUploadRecoveryState | null> {
      await ensureVolcengineUploadRecoverySchema(dependencies.db); const row = await dependencies.db(RECOVERY).where(input).first(); return row ? stateView(row) : null;
    },
  };
}
