/** Keep request/background headroom configurable without changing credentials. */
export function databasePoolSettings(env: Record<string, string | undefined> = process.env) {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key]; if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} 必须为 ${min}—${max} 之间的整数`);
    return value;
  };
  const min = integer('TOONFLOW_DB_POOL_MIN', 2, 0, 200);
  const max = integer('TOONFLOW_DB_POOL_MAX', 30, 1, 200);
  if (min > max) throw new Error('数据库连接池最小值不能大于最大值');
  return { pool: { min, max, idleTimeoutMillis: 60_000 }, acquireConnectionTimeout: 60_000 };
}
