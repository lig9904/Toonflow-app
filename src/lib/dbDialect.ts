/** PostgreSQL-only database contract shared by the app and integration fixtures. */
export const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

export function requirePostgresDatabaseUrl(value = process.env.DATABASE_URL): string {
  if (!value) throw new Error("DATABASE_URL is required; Toonflow only supports PostgreSQL.");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid postgresql:// or postgres:// URL.");
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("DATABASE_URL must use the postgresql:// or postgres:// protocol.");
  }
  return value;
}

/**
 * node-postgres returns int8 values as strings by default. IDs and millisecond
 * timestamps are exposed as JavaScript numbers only when they are safe.
 */
export function parseSafePgBigInt(value: string): number {
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`PostgreSQL bigint ${value} exceeds JavaScript safe integer range.`);
  }
  return Number(parsed);
}

export function configurePostgresTypeParsers(): void {
  // Avoid a static pg import here so an invalid/missing DATABASE_URL fails before
  // the driver is loaded. pg is a required production dependency.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pg = require("pg") as { types: { setTypeParser(oid: number, parser: (value: string) => number): void } };
  pg.types.setTypeParser(20, parseSafePgBigInt); // int8 / bigint
}

export function requirePostgres18Version(serverVersionNumber: string | number): void {
  const version = Number(serverVersionNumber);
  if (!Number.isInteger(version) || version < 180006 || version >= 190000) {
    throw new Error("This deployment requires PostgreSQL 18.6 or a later PostgreSQL 18 minor release.");
  }
}
