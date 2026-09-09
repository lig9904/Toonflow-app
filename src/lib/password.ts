import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

const PREFIX = "scrypt";
const KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export const DEFAULT_PASSWORD = "admin123";

export function isPasswordHash(value: unknown): boolean {
  return typeof value === "string" && /^scrypt\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{40,}$/.test(value);
}

export function assertDeployablePassword(password: string): void {
  if (password === DEFAULT_PASSWORD) throw new Error("不能使用默认部署口令");
  if (password.length < 8) throw new Error("密码至少需要 8 个字符");
}

export function hashPassword(password: string, salt = randomBytes(16)): string {
  assertDeployablePassword(password);
  return hashPasswordInternal(password, salt);
}

export function hashLegacyPassword(password: string, salt = randomBytes(16)): string {
  return hashPasswordInternal(password, salt);
}

function hashPasswordInternal(password: string, salt: Buffer): string {
  const digest = scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `${PREFIX}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

function fixedTimeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function verifyPassword(password: string, stored: unknown): boolean {
  if (typeof stored !== "string") return false;
  if (!isPasswordHash(stored)) return !stored.startsWith("scrypt$") && fixedTimeStringEqual(password, stored);
  const [, saltText, digestText] = stored.split("$");
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(digestText, "base64url");
    if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;
    const actual = scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
