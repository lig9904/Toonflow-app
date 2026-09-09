import knex, { type Knex } from "knex";
import crypto from "node:crypto";
import { configurePostgresTypeParsers, requirePostgresDatabaseUrl } from "@/lib/dbDialect";
import { ensureBaseSchema } from "@/lib/initDB";

export interface PostgresFixture {
  db: Knex;
  schema: string;
  destroy(): Promise<void>;
}

export function getPostgresTestDatabaseUrl(): string {
  const value = process.env.TOONFLOW_TEST_DATABASE_URL;
  if (!value) throw new Error("TOONFLOW_TEST_DATABASE_URL is required for PostgreSQL integration tests.");
  return requirePostgresDatabaseUrl(value);
}

/**
 * Test-only fixture contract. Every call receives a random schema in the
 * dedicated test database. It never starts PostgreSQL or touches DATABASE_URL.
 */
export async function createPostgresFixture(databaseUrl = getPostgresTestDatabaseUrl()): Promise<PostgresFixture> {
  configurePostgresTypeParsers();
  const admin = knex({ client: "pg", connection: databaseUrl, pool: { min: 0, max: 1 } });
  const schema = `toonflow_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.raw(`CREATE SCHEMA "${schema}"`);
  await admin.destroy();

  const db = knex({ client: "pg", connection: databaseUrl, searchPath: [schema], pool: { min: 0, max: 2 } });
  return {
    db,
    schema,
    async destroy() {
      await db.destroy();
      const cleanup = knex({ client: "pg", connection: databaseUrl, pool: { min: 0, max: 1 } });
      try {
        await cleanup.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await cleanup.destroy();
      }
    },
  };
}

/** Create the base tables and deterministic seed rows without any model call. */
export async function migratePostgresFixture(db: Knex): Promise<void> {
  await ensureBaseSchema(db);
}
