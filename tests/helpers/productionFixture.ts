import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import knex, { type Knex } from "knex";
import type { NewStoryboard } from "../../src/services/productionFlow";
import { ensureProductionStateSchema } from "../../src/services/productionState";

export interface ProductionFixture {
  db: Knex;
  directory: string;
}

export async function createProductionFixture(): Promise<ProductionFixture> {
  const directory = mkdtempSync(path.join(tmpdir(), "toonflow-production-flow-"));
  const db = knex({ client: "better-sqlite3", connection: { filename: path.join(directory, "flow.sqlite") }, useNullAsDefault: true });
  await db.schema.createTable("o_user", (table) => { table.integer("id").primary(); table.text("username"); });
  await db.schema.createTable("o_project", (table) => { table.integer("id").primary(); table.integer("userId").notNullable(); table.text("videoRatio"); table.text("imageModel"); table.text("imageQuality"); table.text("artStyle"); });
  await db.schema.createTable("o_script", (table) => { table.integer("id").primary(); table.integer("projectId").notNullable(); table.text("content"); });
  await db.schema.createTable("o_agentWorkData", (table) => {
    table.increments("id"); table.integer("projectId").notNullable(); table.integer("episodesId").notNullable(); table.text("key").notNullable(); table.text("data").notNullable();
  });
  await db.schema.createTable("o_image", (table) => { table.integer("id").primary(); table.text("filePath"); table.text("type"); table.integer("assetsId"); table.text("model"); table.text("resolution"); table.text("state"); table.text("errorReason"); });
  await db.schema.createTable("o_assets", (table) => {
    table.integer("id").primary(); table.integer("projectId").notNullable(); table.integer("scriptId"); table.integer("assetsId"); table.integer("imageId"); table.text("name"); table.text("type"); table.text("prompt"); table.text("describe"); table.text("flowId"); table.integer("startTime");
  });
  await db.schema.createTable("o_scriptAssets", (table) => { table.integer("scriptId").notNullable(); table.integer("assetId").notNullable(); table.primary(["scriptId", "assetId"]); });
  await db.schema.createTable("o_videoTrack", (table) => { table.increments("id"); table.integer("scriptId").notNullable(); table.integer("projectId").notNullable(); table.float("duration").notNullable().defaultTo(0); });
  await db.schema.createTable("o_storyboard", (table) => {
    table.integer("id").primary(); table.integer("projectId").notNullable(); table.integer("scriptId").notNullable(); table.integer("index"); table.text("duration"); table.text("prompt"); table.text("filePath"); table.text("state"); table.text("videoDesc"); table.integer("shouldGenerateImage"); table.text("reason"); table.text("flowId"); table.integer("trackId"); table.text("track"); table.integer("createTime");
  });
  await db.schema.createTable("o_imageFlow", (table) => { table.integer("id").primary(); table.text("flowData").notNullable(); });
  await db.schema.createTable("o_assets2Storyboard", (table) => { table.integer("storyboardId").notNullable(); table.integer("assetId").notNullable(); table.primary(["storyboardId", "assetId"]); });
  await ensureProductionStateSchema(db);
  await db("o_user").insert([{ id: 7, username: "owner" }, { id: 8, username: "other" }]);
  await db("o_project").insert([{ id: 100, userId: 7, videoRatio: "16:9", imageModel: "1:mock-image", imageQuality: "1K", artStyle: "测试风格" }, { id: 200, userId: 8, videoRatio: "16:9", imageModel: "1:mock-image", imageQuality: "1K", artStyle: "测试风格" }]);
  await db("o_script").insert([{ id: 10, projectId: 100, content: "database script" }, { id: 20, projectId: 200, content: "other project script" }]);
  await db("o_image").insert([{ id: 501, assetsId: 1, filePath: "/assets/hero.png", type: "image", state: "已完成", errorReason: null }, { id: 502, assetsId: 2, filePath: "/assets/child.png", type: "image", state: "已完成", errorReason: null }]);
  await db("o_assets").insert([
    { id: 1, projectId: 100, scriptId: 10, assetsId: null, imageId: 501, name: "hero", type: "role", prompt: "hero prompt", describe: "hero desc", flowId: "root" },
    { id: 2, projectId: 100, scriptId: null, assetsId: 1, imageId: 502, name: "hero child", type: "role", prompt: "child prompt", describe: "child desc", flowId: "child" },
    { id: 9, projectId: 200, assetsId: null, imageId: null, name: "foreign", type: "scene", prompt: "foreign prompt", describe: "foreign desc", flowId: "foreign" },
  ]);
  await db("o_scriptAssets").insert([{ scriptId: 10, assetId: 1 }, { scriptId: 10, assetId: 2 }]);
  return { db, directory };
}

export async function closeProductionFixture(fixture: ProductionFixture): Promise<void> {
  await fixture.db.destroy();
  rmSync(fixture.directory, { recursive: true, force: true });
}

export const productionUrl = async (file: string) => `signed:${file}`;

export const newStoryboard = (overrides: Partial<NewStoryboard> = {}): NewStoryboard => ({
  prompt: "new prompt", duration: 3, track: "A", videoDesc: "new description", shouldGenerateImage: 1, associateAssetsIds: [1], ...overrides,
});
