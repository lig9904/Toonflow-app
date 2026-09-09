import type { Knex } from "knex";

export function isPostgres(db: Knex | Knex.Transaction): boolean {
  return ["pg", "postgres", "postgresql"].includes(String(db.client.config.client));
}

/** Serialize short business mutations within a project; provider calls remain outside transactions. */
export async function lockProjectTransaction(trx: Knex.Transaction, projectId: number): Promise<void> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("Invalid project ID");
  if (isPostgres(trx)) await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [`toonflow:project:${projectId}`]);
}

export function withProjectTransaction<T>(db: Knex, projectId: number, operation: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, projectId);
    return operation(trx);
  });
}
