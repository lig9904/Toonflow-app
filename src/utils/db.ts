import { readFile, writeFile } from "fs/promises";
import knex from "knex";
import initDB from "@/lib/initDB";
import { ensureManualExtractionSchema } from "@/services/builtinAgent/manualAssetExtraction";
import { ensureManualPolishSchema } from "@/services/builtinAgent/manualAssetPolish";
import type { DB } from "@/types/database";
import crypto from "crypto";
import fixDB from "@/lib/fixDB";
import { configurePostgresTypeParsers, requirePostgresDatabaseUrl, requirePostgres18Version } from "@/lib/dbDialect";
import { ensureVideoJobsSchema } from "@/services/videoJobs";
import { ensureAgentGatewaySchema } from "@/services/agentGateway";
import { ensureProductionStateSchema } from "@/services/productionState";
import { ensureCreativeWorkspaceSchema } from "@/services/creativeWorkspace";
import { ensureBuiltinAgentRuntimeSchema } from "@/services/builtinAgentRuntime";
import { ensureTeamSchema } from "@/services/team";
import { ensureProjectContentSchema } from "@/services/projectContent";
import { ensureProductionImageJobSchema } from "@/services/imageJobs/runtime";
import { ensureAssetWorkspaceSchema } from "@/services/assetWorkspace";
import { ensureTrackWorkspaceSchema } from "@/services/trackWorkspace";
import { ensureAssetExtractionWorkspaceSchema } from "@/services/assetExtractionWorkspace";
import { ensureProductionAssetSchema } from "@/services/productionAssets";
import { ensureRoleAudioWorkspaceSchema } from "@/services/roleAudioWorkspace";
import { ensureNovelEventWorkspaceSchema } from "@/services/novelEventWorkspace";
import { ensureMediaJobControlSchema } from "@/services/mediaJobControl";
import { ensureImageFlowWorkspaceSchema } from "@/services/imageFlowWorkspace";

type TableName = keyof DB & string;
type RowType<TName extends TableName> = DB[TName];

const connectionString = requirePostgresDatabaseUrl();
configurePostgresTypeParsers();

const db = knex({
  client: "pg",
  connection: connectionString,
  pool: { min: 0, max: 10 },
});

export const dbReady = (async () => {
  const version = await db.raw("SHOW server_version_num");
  requirePostgres18Version(version.rows[0].server_version_num);
  await initDB(db);
  await ensureManualExtractionSchema(db);
  await ensureManualPolishSchema(db);
  await ensureAgentGatewaySchema(db);
  await ensureProductionStateSchema(db);
  await ensureVideoJobsSchema(db);
  await fixDB(db);
  await ensureTeamSchema(db, { bootstrapAdminUserId: Number(process.env.TOONFLOW_ADMIN_USER_ID || 1) });
  await ensureCreativeWorkspaceSchema(db);
  await ensureBuiltinAgentRuntimeSchema(db);
  await ensureProjectContentSchema(db);
  await ensureProductionImageJobSchema(db);
  await ensureAssetWorkspaceSchema(db);
  await ensureTrackWorkspaceSchema(db);
  await ensureAssetExtractionWorkspaceSchema(db);
  await ensureProductionAssetSchema(db);
  await ensureRoleAudioWorkspaceSchema(db);
  await ensureNovelEventWorkspaceSchema(db);
  await ensureMediaJobControlSchema(db);
  await ensureImageFlowWorkspaceSchema(db);
  if (process.env.NODE_ENV == "dev") await initKnexType(db);
})();

// Preserve Knex's non-enumerable transaction/destroy methods. Object.assign
// onto a wrapper function silently drops them even though TypeScript accepts it.
const typedQuery = <TName extends TableName>(table: TName) => db<RowType<TName>, RowType<TName>[]>(table);
const dbClient = db as typeof typedQuery & typeof db;
export default dbClient;

export { db };

async function initKnexType(knexDb: any) {
  const { Client } = await import("@rmp135/sql-ts");
  const outFile = "src/types/database.d.ts";
  const dbClient = Client.fromConfig({
    interfaceNameFormat: "${table}",
    typeMap: {
      number: ["bigint"],
      string: ["text", "varchar", "char"],
    },
  }).fetchDatabase(knexDb);
  const declarations = await dbClient.toTypescript();
  const dbObject = await dbClient.toObject();
  const customHeader = `//该文件由脚本自动生成，请勿手动修改`;
  // 清除上次的注释头
  let declBody = declarations.replace(/^\/\*[\s\S]*?\*\/\s*/, "");
  declBody = declBody.replace(/(\n\s*)\/\*([^*][\s\S]*?)\*\//g, "$1/**$2*/");
  const tableInterfaces = dbObject.schemas.flatMap((schema) => schema.tables.map((table) => table.interfaceName));
  const aggregateTypes = `
export interface DB {
${tableInterfaces.map((name) => `  ${JSON.stringify(name)}: ${name};`).join("\n")}
}
`;
  // 哈希仅基于结构化信息，header和空格不算
  const hashSource = JSON.stringify({
    tableInterfaces,
    declBody,
  });
  const hash = crypto.createHash("md5").update(hashSource).digest("hex");
  // 文件内容
  const content = `// @db-hash ${hash}\n${customHeader}\n\n` + declBody + aggregateTypes;
  let needWrite = true;
  try {
    const current = await readFile(outFile, "utf8");
    // 文件头已存在相同 hash，不需要写
    const match = current.match(/^\/\/\s*@db-hash\s*([a-zA-Z0-9]+)\n/);
    const currentHash = match ? match[1] : null;
    if (currentHash === hash) {
      needWrite = false;
    }
  } catch (err) {
    needWrite = true;
  }
  if (needWrite) await writeFile(outFile, content, "utf8");
}
