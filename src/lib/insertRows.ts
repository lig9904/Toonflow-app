import type { Knex } from "knex";

function asSafeId(value: unknown, table: string, idColumn: string): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id)) throw new RangeError(`${table}.${idColumn} is not a safe JavaScript integer.`);
  return id;
}

/**
 * PostgreSQL does not return inserted IDs unless RETURNING is requested. Keep
 * this explicit instead of changing Knex internals or relying on SQLite rowid.
 */
export async function insertRowsReturningIds(
  db: Knex | Knex.Transaction,
  table: string,
  data: Record<string, unknown> | readonly Record<string, unknown>[],
  idColumn = "id",
): Promise<number[]> {
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0) return [];
  const returned = await db(table).insert(rows).returning<{ [key: string]: unknown }[]>(idColumn);
  return returned.map((row) => asSafeId(row[idColumn], table, idColumn));
}
