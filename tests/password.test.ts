import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PASSWORD, assertDeployablePassword, hashPassword, hashLegacyPassword, isPasswordHash, verifyPassword } from "../src/lib/password";

describe("password handling", () => {
  it("hashes with a random salt and verifies without exposing plaintext", () => {
    const first = hashPassword("a-long-deployment-password");
    const second = hashPassword("a-long-deployment-password");
    assert.equal(isPasswordHash(first), true);
    assert.notEqual(first, second);
    assert.equal(first.includes("a-long-deployment-password"), false);
    assert.equal(verifyPassword("a-long-deployment-password", first), true);
    assert.equal(verifyPassword("wrong-password", first), false);
  });

  it("accepts legacy plaintext only for compatibility and upgrades it through a hash", () => {
    assert.equal(verifyPassword("legacy-secret", "legacy-secret"), true);
    assert.equal(verifyPassword("wrong", "legacy-secret"), false);
    const upgraded = hashLegacyPassword("legacy-secret");
    assert.equal(isPasswordHash(upgraded), true);
    assert.equal(verifyPassword("legacy-secret", upgraded), true);
  });

  it("rejects the default seed password for new or changed credentials", () => {
    assert.throws(() => assertDeployablePassword(DEFAULT_PASSWORD), /默认部署口令/);
    assert.throws(() => hashPassword(DEFAULT_PASSWORD), /默认部署口令/);
    assert.doesNotThrow(() => assertDeployablePassword("a-random-server-secret"));
  });
});
