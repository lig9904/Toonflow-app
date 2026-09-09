import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { lockProjectTransaction } from "../../lib/dbTransaction";
import { advanceCreativeState, CreativeWorkspaceError, ensureCreativeWorkspaceSchema, getCreativeState } from "../creativeWorkspace";
import type { TrustedActor } from "../productionState";

const RECEIPTS = "ext_role_audio_mutations";
const id = z.number().int().positive();
const version = z.number().int().nonnegative();
const key = z.string().min(8).max(150).regex(/^[\w:.-]+$/);

const bindingItemSchema = z.object({
  roleAssetId: id,
  expectedVersion: version,
  audioIds: z.array(id).max(100).optional(),
  audioVersions: z.array(z.object({ id, expectedVersion: version }).strict()).max(100).optional(),
  audioFamilySnapshot: z.object({
    familyId: id,
    expectedVersion: version,
    children: z.array(z.object({ id, expectedVersion: version }).strict()).min(1).max(100),
  }).strict().optional(),
}).strict();

export const saveRoleAudioBindingsSchema = z.object({
  projectId: id,
  items: z.array(bindingItemSchema).min(1).max(500),
  idempotencyKey: key,
}).strict();

export const requestAudioMatchSchema = z.object({
  projectId: id,
  items: z.array(z.object({ roleAssetId: id, expectedVersion: version }).strict()).min(1).max(500),
  idempotencyKey: key,
}).strict();

export class RoleAudioWorkspaceError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "PROJECT_MISMATCH" | "TYPE_MISMATCH" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "LOCKED" | "RUNTIME_UNAVAILABLE",
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "RoleAudioWorkspaceError";
  }
}

export interface BoundAudioReference {
  roleAssetId: number;
  familyId: number;
  id: number;
  name: string;
  describe: string;
  prompt: string;
  filePath: string;
  version: number;
}

export interface AudioMatchContext {
  phase: "matchAudio";
  modelKey: "universalAi";
  promptType: "audioBindPrompt";
  projectId: number;
  roles: Array<{ id: number; name: string; describe: string; version: number }>;
  candidates: Array<{
    familyId: number;
    name: string;
    describe: string;
    version: number;
    children: Array<{ id: number; name: string; describe: string; version: number }>;
  }>;
}

export interface AudioMatchRunReceipt {
  run: { id: string; status: string; version: number; intent?: unknown; [key: string]: unknown };
  reused: boolean;
}

export type AudioMatchRunStarter = (input: {
  requestedBy: number;
  idempotencyKey: string;
  context: AudioMatchContext;
}) => Promise<AudioMatchRunReceipt>;
export type AudioMatchRunLookup = (requestedBy: number, idempotencyKey: string) => Promise<AudioMatchRunReceipt | undefined>;

let audioMatchRunStarter: AudioMatchRunStarter | undefined;
let audioMatchRunLookup: AudioMatchRunLookup | undefined;

/** Application bootstrap installs the builtin-runtime phase adapter here. */
export function configureAudioMatchRunStarter(starter: AudioMatchRunStarter, lookup?: AudioMatchRunLookup): void {
  audioMatchRunStarter = starter;
  audioMatchRunLookup = lookup;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RoleAudioWorkspaceError("INVALID_INPUT", result.error.issues.map((issue) => issue.message).join("; "));
  return result.data;
}

function actorId(actor: TrustedActor): string {
  if (!actor?.id || !["human", "agent", "system"].includes(actor.kind)) throw new RoleAudioWorkspaceError("INVALID_INPUT", "缺少可信操作身份");
  return actor.id;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((name) => `${JSON.stringify(name)}:${canonical(record[name])}`).join(",")}}`;
}

const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export async function ensureRoleAudioWorkspaceSchema(db: Knex): Promise<void> {
  await ensureCreativeWorkspaceSchema(db);
  if (!(await db.schema.hasTable(RECEIPTS))) {
    await db.schema.createTable(RECEIPTS, (table) => {
      table.text("actorId").notNullable();
      table.bigInteger("projectId").notNullable();
      table.text("idempotencyKey").notNullable();
      table.text("requestHash").notNullable();
      table.text("result").notNullable();
      table.bigInteger("createdAt").notNullable();
      table.primary(["actorId", "projectId", "idempotencyKey"]);
    });
  }
}

async function receipt<T>(db: Knex | Knex.Transaction, actor: string, projectId: number, idempotencyKey: string, requestHash: string): Promise<T | undefined> {
  const row = await db(RECEIPTS).where({ actorId: actor, projectId, idempotencyKey }).first();
  if (!row) return undefined;
  if (row.requestHash !== requestHash) throw new RoleAudioWorkspaceError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同内容", 409);
  return JSON.parse(row.result) as T;
}

async function assertProject(db: Knex | Knex.Transaction, projectId: number): Promise<void> {
  if (!(await db("o_project").where({ id: projectId }).first())) throw new RoleAudioWorkspaceError("NOT_FOUND", "项目不存在", 404);
}

async function advanceRoleState(trx: Knex.Transaction, roleAssetId: number, projectId: number, expectedVersion: number, actor: TrustedActor): Promise<void> {
  try {
    await advanceCreativeState(trx, { entityType: "asset", entityId: roleAssetId, projectId, expectedVersion, actor });
  } catch (error) {
    if (error instanceof CreativeWorkspaceError) {
      const status = error.code === "VERSION_CONFLICT" ? 409 : error.code === "PROJECT_MISMATCH" ? 403 : 400;
      throw new RoleAudioWorkspaceError(error.code, error.message, status);
    }
    throw error;
  }
}

async function roleFamily(db: Knex | Knex.Transaction, projectId: number, roleAssetId: number): Promise<{ role: any; familyIds: number[] }> {
  const role = await db("o_assets").where({ id: roleAssetId }).first();
  if (!role || Number(role.projectId) !== projectId) throw new RoleAudioWorkspaceError("PROJECT_MISMATCH", "角色素材不属于当前项目", 403);
  if (role.type !== "role") throw new RoleAudioWorkspaceError("TYPE_MISMATCH", "仅角色素材可以绑定音色");
  const rootId = role.assetsId == null ? roleAssetId : Number(role.assetsId);
  const root = await db("o_assets").where({ id: rootId, projectId }).first();
  if (!root || root.type !== "role" || root.assetsId != null) throw new RoleAudioWorkspaceError("TYPE_MISMATCH", "角色派生素材缺少本项目顶层角色");
  const children = await db("o_assets").where({ projectId, assetsId: rootId }).select("id");
  return { role, familyIds: [rootId, ...children.map((row) => Number(row.id))] };
}

async function assertUnlocked(db: Knex.Transaction, projectId: number, familyIds: number[]): Promise<void> {
  if (!(await db.schema.hasTable("ext_entity_state"))) return;
  const locked = await db("o_assets2Storyboard as link")
    .join("o_storyboard as storyboard", "storyboard.id", "link.storyboardId")
    .join("ext_entity_state as state", function joinState() {
      this.on("state.entityType", "=", db.raw("?", ["storyboard"]))
        .andOn("state.entityId", "=", "storyboard.id")
        .andOn("state.locked", "=", db.raw("?", [1]));
    })
    .where("storyboard.projectId", projectId)
    .whereIn("link.assetId", familyIds)
    .first("storyboard.id");
  if (locked) throw new RoleAudioWorkspaceError("LOCKED", "锁定分镜引用了该角色，不能修改音色", 423);
}

async function audioFamily(db: Knex | Knex.Transaction, projectId: number, audioId: number): Promise<{ family: any; selected: any; children: any[] }> {
  const selected = await db("o_assets").where({ id: audioId }).first();
  if (!selected || Number(selected.projectId) !== projectId) throw new RoleAudioWorkspaceError("PROJECT_MISMATCH", "音频素材不属于当前项目", 403);
  if (selected.type !== "audio") throw new RoleAudioWorkspaceError("TYPE_MISMATCH", "所选素材不是音频");
  const familyId = selected.assetsId == null ? audioId : Number(selected.assetsId);
  const family = await db("o_assets").where({ id: familyId, projectId }).first();
  if (!family || family.type !== "audio" || family.assetsId != null) throw new RoleAudioWorkspaceError("TYPE_MISMATCH", "所选音频不属于有效的顶层音频家族");
  const children = await db("o_assets as asset")
    .join("o_image as media", "media.id", "asset.imageId")
    .where({ "asset.projectId": projectId, "asset.assetsId": familyId, "asset.type": "audio", "media.type": "audio" })
    .whereIn("media.state", ["已完成", "生成成功"])
    .whereNotNull("media.filePath")
    .select("asset.*", "media.filePath")
    .orderBy("asset.id");
  if (!children.length) throw new RoleAudioWorkspaceError("INVALID_INPUT", "所选音频家族没有可用的子音频");
  return { family, selected, children };
}

async function bindingView(db: Knex | Knex.Transaction, projectId: number, roleAssetId: number): Promise<any> {
  const role = await db("o_assets").where({ id: roleAssetId, projectId }).first();
  if (!role) throw new RoleAudioWorkspaceError("PROJECT_MISMATCH", "角色素材不属于当前项目", 403);
  const version = (await getCreativeState(db as Knex, "asset", roleAssetId, projectId)).version;
  const links = await db("o_assetsRole2Audio as link")
    .join("o_assets as family", "family.id", "link.assetsAudioId")
    .where({ "link.assetsRoleId": roleAssetId, "family.projectId": projectId, "family.type": "audio" })
    .whereNull("family.assetsId")
    .select("family.id", "family.name", "family.describe")
    .orderBy("family.id");
  return { roleAssetId, version, audioFamilies: links.map((row) => ({ id: Number(row.id), name: String(row.name ?? ""), describe: String(row.describe ?? "") })) };
}

export async function readRoleAudioBindings(db: Knex, projectId: number, roleAssetIds: readonly number[]): Promise<any[]> {
  await assertProject(db, projectId);
  return Promise.all(roleAssetIds.map((roleAssetId) => bindingView(db, projectId, roleAssetId)));
}

export async function saveRoleAudioBindings(db: Knex, raw: unknown, actor: TrustedActor): Promise<{ bindings: any[]; reused: boolean }> {
  const input = parse(saveRoleAudioBindingsSchema, raw);
  const who = actorId(actor);
  if (new Set(input.items.map((item) => item.roleAssetId)).size !== input.items.length) throw new RoleAudioWorkspaceError("INVALID_INPUT", "同一请求不能重复修改角色音色");
  const normalized = { ...input, items: [...input.items].sort((left, right) => left.roleAssetId - right.roleAssetId) };
  const requestHash = hash(normalized);
  return db.transaction(async (trx) => {
    await lockProjectTransaction(trx, input.projectId);
    const old = await receipt<{ bindings: any[] }>(trx, who, input.projectId, input.idempotencyKey, requestHash);
    if (old) return { ...old, reused: true };
    await assertProject(trx, input.projectId);
    const changes: Array<{ item: typeof input.items[number]; familyId?: number; currentIds: number[]; familyIds: number[] }> = [];
    for (const item of normalized.items) {
      const role = await roleFamily(trx, input.projectId, item.roleAssetId);
      const state = await getCreativeState(trx, "asset", item.roleAssetId, input.projectId);
      if (state.version !== item.expectedVersion) throw new RoleAudioWorkspaceError("VERSION_CONFLICT", "角色素材已被修改，请读取最新版本", 409);
      const current = await trx("o_assetsRole2Audio").where({ assetsRoleId: item.roleAssetId }).select("assetsAudioId");
      const currentIds = current.map((row) => Number(row.assetsAudioId)).sort((a, b) => a - b);
      if (item.audioIds === undefined) {
        changes.push({ item, currentIds, familyIds: role.familyIds });
        continue;
      }
      const versionMap = new Map((item.audioVersions ?? []).map((entry) => [entry.id, entry.expectedVersion]));
      if (versionMap.size !== item.audioIds.length || item.audioIds.some((audioId) => !versionMap.has(audioId))) throw new RoleAudioWorkspaceError("INVALID_INPUT", "每个所选音频必须携带最新版本");
      const families = [] as number[];
      for (const audioId of item.audioIds) {
        const audio = await audioFamily(trx, input.projectId, audioId);
        const selectedState = await getCreativeState(trx, "asset", audioId, input.projectId);
        if (selectedState.version !== versionMap.get(audioId)) throw new RoleAudioWorkspaceError("VERSION_CONFLICT", "音频素材已被修改，请重新选择", 409);
        families.push(Number(audio.family.id));
      }
      const uniqueFamilies = [...new Set(families)];
      if (uniqueFamilies.length > 1) throw new RoleAudioWorkspaceError("INVALID_INPUT", "一个角色最多绑定一个顶层音频家族");
      if (item.audioFamilySnapshot) {
        const snapshot = item.audioFamilySnapshot;
        if (uniqueFamilies.length !== 1 || uniqueFamilies[0] !== snapshot.familyId) throw new RoleAudioWorkspaceError("PROJECT_MISMATCH", "模型选择与音频候选快照不一致", 403);
        const currentFamily = await audioFamily(trx, input.projectId, snapshot.familyId);
        const familyState = await getCreativeState(trx, "asset", snapshot.familyId, input.projectId);
        if (familyState.version !== snapshot.expectedVersion) throw new RoleAudioWorkspaceError("VERSION_CONFLICT", "音频家族已被修改，请重新匹配", 409);
        const expectedChildren = [...snapshot.children].sort((left, right) => left.id - right.id);
        const currentChildren = currentFamily.children.map((child) => Number(child.id)).sort((left, right) => left - right);
        if (canonical(currentChildren) !== canonical(expectedChildren.map((child) => child.id))) throw new RoleAudioWorkspaceError("VERSION_CONFLICT", "音频家族子项已变化，请重新匹配", 409);
        for (const child of expectedChildren) {
          const childState = await getCreativeState(trx, "asset", child.id, input.projectId);
          if (childState.version !== child.expectedVersion) throw new RoleAudioWorkspaceError("VERSION_CONFLICT", "音频家族子项已被修改，请重新匹配", 409);
        }
      }
      changes.push({ item, familyId: uniqueFamilies[0], currentIds, familyIds: role.familyIds });
    }

    for (const change of changes) {
      if (change.item.audioIds === undefined) continue;
      const nextIds = change.familyId === undefined ? [] : [change.familyId];
      if (change.currentIds.length === nextIds.length && change.currentIds.every((value, index) => value === nextIds[index])) continue;
      await assertUnlocked(trx, input.projectId, change.familyIds);
      await advanceRoleState(trx, change.item.roleAssetId, input.projectId, change.item.expectedVersion, actor);
      await trx("o_assetsRole2Audio").where({ assetsRoleId: change.item.roleAssetId }).delete();
      if (change.familyId !== undefined) await trx("o_assetsRole2Audio").insert({ assetsRoleId: change.item.roleAssetId, assetsAudioId: change.familyId });
    }
    const bindings = await Promise.all(normalized.items.map((item) => bindingView(trx, input.projectId, item.roleAssetId)));
    const result = { bindings };
    await trx(RECEIPTS).insert({ actorId: who, projectId: input.projectId, idempotencyKey: input.idempotencyKey, requestHash, result: JSON.stringify(result), createdAt: Date.now() });
    return { ...result, reused: false };
  });
}

export async function saveRoleAudioBinding(db: Knex, raw: unknown, actor: TrustedActor): Promise<{ binding: any; reused: boolean }> {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const item = parse(bindingItemSchema, {
    roleAssetId: value.roleAssetId,
    expectedVersion: value.expectedVersion,
    ...(value.audioIds === undefined ? {} : { audioIds: value.audioIds }),
    ...(value.audioVersions === undefined ? {} : { audioVersions: value.audioVersions }),
    ...(value.audioFamilySnapshot === undefined ? {} : { audioFamilySnapshot: value.audioFamilySnapshot }),
  });
  const projectId = Number(value.projectId);
  const idempotencyKey = String(value.idempotencyKey ?? "");
  const result = await saveRoleAudioBindings(db, { projectId, items: [item], idempotencyKey }, actor);
  return { binding: result.bindings[0], reused: result.reused };
}

export async function readBoundAudioReferences(db: Knex, projectId: number, roleAssetIds: readonly number[]): Promise<BoundAudioReference[]> {
  if (!roleAssetIds.length) return [];
  const uniqueRoleIds = [...new Set(roleAssetIds.map(Number))];
  const roles = await db("o_assets").where({ projectId }).whereIn("id", uniqueRoleIds).where({ type: "role" }).select("id");
  if (roles.length !== uniqueRoleIds.length) throw new RoleAudioWorkspaceError("PROJECT_MISMATCH", "角色素材不属于当前项目", 403);
  const rows = await db("o_assetsRole2Audio as link")
    .join("o_assets as family", "family.id", "link.assetsAudioId")
    .join("o_assets as child", "child.assetsId", "family.id")
    .join("o_image as media", "media.id", "child.imageId")
    .whereIn("link.assetsRoleId", uniqueRoleIds)
    .where({ "family.projectId": projectId, "family.type": "audio", "child.projectId": projectId, "child.type": "audio", "media.type": "audio" })
    .whereNull("family.assetsId")
    .whereIn("media.state", ["已完成", "生成成功"])
    .whereNotNull("media.filePath")
    .select("link.assetsRoleId", "family.id as familyId", "child.id", "child.name", "child.describe", "child.prompt", "media.filePath")
    .orderBy(["link.assetsRoleId", "family.id", "child.id"]);
  const states = rows.length ? await db("ext_creative_state").where({ entityType: "asset", projectId }).whereIn("entityId", rows.map((row) => row.id)) : [];
  return rows.map((row) => ({
    roleAssetId: Number(row.assetsRoleId), familyId: Number(row.familyId), id: Number(row.id), name: String(row.name ?? ""),
    describe: String(row.describe ?? ""), prompt: String(row.prompt ?? ""), filePath: String(row.filePath),
    version: Number(states.find((state) => Number(state.entityId) === Number(row.id))?.version ?? 0),
  }));
}

export async function prepareAudioMatchContext(db: Knex, raw: unknown): Promise<AudioMatchContext> {
  const input = parse(requestAudioMatchSchema, raw);
  if (new Set(input.items.map((item) => item.roleAssetId)).size !== input.items.length) throw new RoleAudioWorkspaceError("INVALID_INPUT", "同一音色匹配请求不能重复选择角色");
  await assertProject(db, input.projectId);
  const roles: AudioMatchContext["roles"] = [];
  for (const item of input.items) {
    const role = await roleFamily(db, input.projectId, item.roleAssetId);
    const currentVersion = (await getCreativeState(db, "asset", item.roleAssetId, input.projectId)).version;
    if (currentVersion !== item.expectedVersion) throw new RoleAudioWorkspaceError("VERSION_CONFLICT", "角色素材已被修改，请刷新后重试", 409);
    roles.push({ id: item.roleAssetId, name: String(role.role.name ?? ""), describe: String(role.role.describe ?? ""), version: currentVersion });
  }
  const families = await db("o_assets").where({ projectId: input.projectId, type: "audio" }).whereNull("assetsId").orderBy("id");
  const candidates: AudioMatchContext["candidates"] = [];
  for (const family of families) {
    const children = await audioFamily(db, input.projectId, Number(family.id)).then((value) => value.children).catch((error) => {
      if (error instanceof RoleAudioWorkspaceError && error.code === "INVALID_INPUT") return [];
      throw error;
    });
    if (!children.length) continue;
    const familyVersion = (await getCreativeState(db, "asset", Number(family.id), input.projectId)).version;
    const childStates = await db("ext_creative_state").where({ entityType: "asset", projectId: input.projectId }).whereIn("entityId", children.map((child) => child.id));
    candidates.push({
      familyId: Number(family.id), name: String(family.name ?? ""), describe: String(family.describe ?? ""), version: familyVersion,
      children: children.map((child) => ({ id: Number(child.id), name: String(child.name ?? ""), describe: String(child.describe ?? ""), version: Number(childStates.find((state) => Number(state.entityId) === Number(child.id))?.version ?? 0) })),
    });
  }
  if (!candidates.length) throw new RoleAudioWorkspaceError("INVALID_INPUT", "暂无可用音频，请先上传音频");
  return { phase: "matchAudio", modelKey: "universalAi", promptType: "audioBindPrompt", projectId: input.projectId, roles, candidates };
}

export async function startAudioMatchRun(db: Knex, raw: unknown, requestedBy: number): Promise<AudioMatchRunReceipt> {
  const input = parse(requestAudioMatchSchema, raw);
  if (!Number.isSafeInteger(requestedBy) || requestedBy <= 0) throw new RoleAudioWorkspaceError("INVALID_INPUT", "用户编号无效", 401);
  if (audioMatchRunLookup) {
    const existing = await audioMatchRunLookup(requestedBy, input.idempotencyKey);
    if (existing) {
      const intent = existing.run.intent as { phase?: unknown; context?: { projectId?: unknown; roles?: Array<{ id?: unknown; version?: unknown }> } } | undefined;
      const expected = [...input.items].sort((left, right) => left.roleAssetId - right.roleAssetId).map((item) => ({ id: item.roleAssetId, version: item.expectedVersion }));
      const actual = Array.isArray(intent?.context?.roles)
        ? intent.context.roles.map((role) => ({ id: Number(role.id), version: Number(role.version) })).sort((left, right) => left.id - right.id)
        : [];
      if (intent?.phase !== "matchAudio" || Number(intent.context?.projectId) !== input.projectId || canonical(actual) !== canonical(expected)) {
        throw new RoleAudioWorkspaceError("IDEMPOTENCY_CONFLICT", "操作编号已用于不同的音色匹配请求", 409);
      }
      return { ...existing, reused: true };
    }
  }
  const context = await prepareAudioMatchContext(db, input);
  if (!audioMatchRunStarter) throw new RoleAudioWorkspaceError("RUNTIME_UNAVAILABLE", "音色匹配运行时尚未接入", 503);
  return audioMatchRunStarter({ requestedBy, idempotencyKey: input.idempotencyKey, context });
}

/** Model output is untrusted and passes through the same ownership/version/lock checks as manual edits. */
export async function applyAudioMatchProposal(db: Knex, input: z.infer<typeof saveRoleAudioBindingsSchema>, actor: TrustedActor): Promise<{ bindings: any[]; reused: boolean }> {
  return saveRoleAudioBindings(db, input, actor);
}
