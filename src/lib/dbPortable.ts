import type { Knex } from "knex";

export function isPostgres(db: Knex): boolean {
  return ["pg", "postgres", "postgresql"].includes(String((db.client.config as { client?: string }).client));
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error("非法数据库标识符");
  return `"${identifier}"`;
}

function rawRows(result: any): any[] {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

export async function listUserTables(db: Knex): Promise<string[]> {
  if (isPostgres(db)) {
    const result = await db.raw(`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
        AND table_name NOT LIKE 'knex_%'
      ORDER BY table_name
    `);
    return rawRows(result).map((row) => String(row.name));
  }
  const result = await db.raw(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'knex_%' ORDER BY name`);
  return rawRows(result).map((row) => String(row.name));
}

export async function hasUserTable(db: Knex, tableName: string): Promise<boolean> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) return false;
  return (await listUserTables(db)).includes(tableName);
}
