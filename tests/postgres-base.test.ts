import assert from "node:assert/strict";
import test from "node:test";
import { requirePostgresDatabaseUrl, requirePostgres18Version } from "@/lib/dbDialect";
import { insertRowsReturningIds } from "@/lib/insertRows";
import { createPostgresFixture, migratePostgresFixture } from "@/lib/postgresTest";

test("PostgreSQL base schema is idempotent and returns generated bigint IDs", { skip: !process.env.TOONFLOW_TEST_DATABASE_URL }, async () => {
  const fixture = await createPostgresFixture();
  const { db } = fixture;
  try {
    await migratePostgresFixture(db);
    await migratePostgresFixture(db);

    const [projectId] = await insertRowsReturningIds(db, "o_project", { name: "postgres-fixture", createTime: Date.now() });
    assert.ok(Number.isSafeInteger(projectId));
    const [userId] = await insertRowsReturningIds(db, "o_user", { name: "fixture-user", password: "unused" });
    assert.ok(userId > 1);
    for (const skill of await db("o_skillList").select("embedding")) assert.ok(Array.isArray(JSON.parse(skill.embedding)));

    const relationId = await db("information_schema.columns")
      .where({ table_schema: fixture.schema, table_name: "o_assets2Storyboard", column_name: "id" })
      .first();
    assert.ok(relationId);
  } finally {
    await fixture.destroy();
  }
});

test("DATABASE_URL rejects non-PostgreSQL protocols", () => {
  assert.throws(() => requirePostgresDatabaseUrl("sqlite:///tmp/toonflow.sqlite"), /postgresql/);
});


test("runtime requires PostgreSQL 18.6 while allowing later 18.x security patches", () => {
  assert.doesNotThrow(() => requirePostgres18Version("180006"));
  assert.doesNotThrow(() => requirePostgres18Version("180007"));
  assert.throws(() => requirePostgres18Version("170011"), /18.6/);
  assert.throws(() => requirePostgres18Version("180005"), /18.6/);
  assert.throws(() => requirePostgres18Version("190000"), /18.6/);
});
