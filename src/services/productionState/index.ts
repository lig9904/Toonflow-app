import type { Knex } from "knex";
import { lockProjectTransaction } from "@/lib/dbTransaction";

const ENTITY_TYPE = "storyboard";
const STORYBOARD_CONTENT_COLUMNS = ["prompt", "videoDesc"] as const;

export type ReviewState = "draft" | "pending" | "approved" | "revision";
export type ActorKind = "human" | "agent" | "system";

/**
 * This value must come from authenticated server-side context.  Route handlers
 * must never construct it from a request body's `actor` field.
 */
export interface TrustedActor {
  id: string;
  kind: ActorKind;
}

export interface StoryboardRecord {
  id: number;
  scriptId: number | null;
  prompt: string | null;
  videoDesc: string | null;
  state?: string | null;
  [column: string]: unknown;
}

export interface ProductionEntityState {
  entityType: typeof ENTITY_TYPE;
  entityId: number;
  projectId: number;
  version: number;
  reviewState: ReviewState;
  locked: boolean;
  lockedBy: string | null;
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface StoryboardWithState {
  storyboard: StoryboardRecord;
  state: ProductionEntityState;
}

export interface ProductionStateServiceOptions {
  now?: () => number;
}

export class ProductionStateError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "PROJECT_MISMATCH" | "VERSION_CONFLICT" | "LOCKED" | "FORBIDDEN" | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "ProductionStateError";
  }
}

export interface UpdateStoryboardContentInput {
  projectId: number;
  storyboardId: number;
  expectedVersion: number;
  actor: TrustedActor;
  patch: Partial<Pick<StoryboardRecord, (typeof STORYBOARD_CONTENT_COLUMNS)[number]>>;
}

export interface ChangeReviewStateInput {
  projectId: number;
  storyboardId: number;
  expectedVersion: number;
  actor: TrustedActor;
  reviewState: ReviewState;
}

export interface ChangeLockInput {
  projectId: number;
  storyboardId: number;
  expectedVersion: number;
  actor: TrustedActor;
}

interface StateRow {
  entityType: string;
  entityId: number;
  projectId: number;
  version: number;
  reviewState: ReviewState;
  locked: number | boolean;
  lockedBy: string | null;
  updatedBy: string | null;
  updatedAt: number | null;
  internalMutation: string | null;
}

type StatePatch = Partial<Pick<StateRow, "reviewState" | "locked" | "lockedBy" | "updatedBy" | "updatedAt" | "internalMutation">>;

interface StoryboardContext {
  storyboard: StoryboardRecord;
  state: ProductionEntityState;
}

type DbLike = Knex | Knex.Transaction;

export async function ensureProductionStateSchema(db: Knex): Promise<void> {
  if (isPostgres(db)) {
    await db.transaction(async (trx) => {
      await trx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", ["toonflow:production-state-schema"]);
      await ensureProductionStatePostgresSchema(trx);
    });
    return;
  }
  const exists = await db.schema.hasTable("ext_entity_state");
  if (!exists) {
    await db.schema.createTable("ext_entity_state", (table) => {
      table.text("entityType").notNullable();
      table.integer("entityId").notNullable();
      table.integer("projectId").notNullable();
      table.integer("version").notNullable().defaultTo(0);
      table.text("reviewState").notNullable().defaultTo("draft");
      table.boolean("locked").notNullable().defaultTo(false);
      table.text("lockedBy");
      table.text("updatedBy");
      table.integer("updatedAt");
      // A transaction-local reservation marker. It stops legacy-write triggers
      // from double-incrementing a version already advanced by this service.
      table.text("internalMutation");
      table.primary(["entityType", "entityId"]);
      table.index(["projectId", "entityType"]);
    });
  }

  await Promise.all([
    db.raw(`
      CREATE TRIGGER IF NOT EXISTS ext_storyboard_reject_locked_update
      BEFORE UPDATE ON o_storyboard
      WHEN EXISTS (
        SELECT 1 FROM ext_entity_state
        WHERE entityType = '${ENTITY_TYPE}' AND entityId = OLD.id AND locked = 1
      )
      BEGIN SELECT RAISE(ABORT, 'storyboard is locked'); END;
    `),
    db.raw(`
      CREATE TRIGGER IF NOT EXISTS ext_storyboard_reject_locked_delete
      BEFORE DELETE ON o_storyboard
      WHEN EXISTS (
        SELECT 1 FROM ext_entity_state
        WHERE entityType = '${ENTITY_TYPE}' AND entityId = OLD.id AND locked = 1
      )
      BEGIN SELECT RAISE(ABORT, 'storyboard is locked'); END;
    `),
    db.raw(`
      CREATE TRIGGER IF NOT EXISTS ext_storyboard_legacy_version
      AFTER UPDATE ON o_storyboard
      WHEN NOT EXISTS (
        SELECT 1 FROM ext_entity_state
        WHERE entityType = '${ENTITY_TYPE}' AND entityId = NEW.id AND internalMutation IS NOT NULL
      )
      AND (
        OLD.scriptId IS NOT NEW.scriptId OR OLD.prompt IS NOT NEW.prompt OR OLD.filePath IS NOT NEW.filePath
        OR OLD.duration IS NOT NEW.duration OR OLD.state IS NOT NEW.state OR OLD.trackId IS NOT NEW.trackId
        OR OLD.reason IS NOT NEW.reason OR OLD.track IS NOT NEW.track OR OLD.videoDesc IS NOT NEW.videoDesc
        OR OLD.shouldGenerateImage IS NOT NEW.shouldGenerateImage OR OLD.projectId IS NOT NEW.projectId
        OR OLD.flowId IS NOT NEW.flowId OR OLD."index" IS NOT NEW."index" OR OLD.createTime IS NOT NEW.createTime
      )
      BEGIN
        INSERT INTO ext_entity_state (
          entityType, entityId, projectId, version, reviewState, locked, lockedBy, updatedBy, updatedAt, internalMutation
        ) VALUES (
          '${ENTITY_TYPE}', NEW.id,
          (SELECT projectId FROM o_script WHERE id = NEW.scriptId),
          1, 'draft', 0, NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
        ) ON CONFLICT(entityType, entityId) DO UPDATE SET
          projectId = excluded.projectId,
          version = ext_entity_state.version + 1,
          reviewState = 'draft',
          updatedBy = NULL,
          updatedAt = excluded.updatedAt;
      END;
    `),
    db.raw(`
      CREATE TRIGGER IF NOT EXISTS ext_storyboard_delete_state
      AFTER DELETE ON o_storyboard
      BEGIN
        DELETE FROM ext_entity_state WHERE entityType = '${ENTITY_TYPE}' AND entityId = OLD.id;
      END;
    `),
    db.raw(`
      CREATE TRIGGER IF NOT EXISTS ext_storyboard_asset_insert_locked
      BEFORE INSERT ON o_assets2Storyboard
      WHEN EXISTS (
        SELECT 1 FROM ext_entity_state
        WHERE entityType = '${ENTITY_TYPE}' AND entityId = NEW.storyboardId AND locked = 1
      )
      BEGIN SELECT RAISE(ABORT, 'storyboard is locked'); END;
    `),
    db.raw(`
      CREATE TRIGGER IF NOT EXISTS ext_storyboard_asset_update_locked
      BEFORE UPDATE ON o_assets2Storyboard
      WHEN EXISTS (
        SELECT 1 FROM ext_entity_state
        WHERE entityType = '${ENTITY_TYPE}' AND entityId IN (OLD.storyboardId, NEW.storyboardId) AND locked = 1
      )
      BEGIN SELECT RAISE(ABORT, 'storyboard is locked'); END;
    `),
    db.raw(`
      CREATE TRIGGER IF NOT EXISTS ext_storyboard_asset_delete_locked
      BEFORE DELETE ON o_assets2Storyboard
      WHEN EXISTS (
        SELECT 1 FROM ext_entity_state
        WHERE entityType = '${ENTITY_TYPE}' AND entityId = OLD.storyboardId AND locked = 1
      )
      BEGIN SELECT RAISE(ABORT, 'storyboard is locked'); END;
    `),
    db.raw(`
      CREATE TRIGGER IF NOT EXISTS ext_storyboard_asset_insert_version
      AFTER INSERT ON o_assets2Storyboard
      BEGIN
        INSERT INTO ext_entity_state (
          entityType, entityId, projectId, version, reviewState, locked, lockedBy, updatedBy, updatedAt, internalMutation
        )
        SELECT '${ENTITY_TYPE}', storyboard.id, script.projectId, 1, 'draft', 0, NULL, NULL,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
        FROM o_storyboard AS storyboard
        JOIN o_script AS script ON script.id = storyboard.scriptId
        WHERE storyboard.id = NEW.storyboardId
        ON CONFLICT(entityType, entityId) DO UPDATE SET
          projectId = excluded.projectId,
          version = ext_entity_state.version + 1,
          reviewState = 'draft',
          updatedBy = NULL,
          updatedAt = excluded.updatedAt;
      END;
    `),
    db.raw(`
      CREATE TRIGGER IF NOT EXISTS ext_storyboard_asset_delete_version
      AFTER DELETE ON o_assets2Storyboard
      BEGIN
        INSERT INTO ext_entity_state (
          entityType, entityId, projectId, version, reviewState, locked, lockedBy, updatedBy, updatedAt, internalMutation
        )
        SELECT '${ENTITY_TYPE}', storyboard.id, script.projectId, 1, 'draft', 0, NULL, NULL,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
        FROM o_storyboard AS storyboard
        JOIN o_script AS script ON script.id = storyboard.scriptId
        WHERE storyboard.id = OLD.storyboardId
        ON CONFLICT(entityType, entityId) DO UPDATE SET
          projectId = excluded.projectId,
          version = ext_entity_state.version + 1,
          reviewState = 'draft',
          updatedBy = NULL,
          updatedAt = excluded.updatedAt;
      END;
    `),
    db.raw(`
      CREATE TRIGGER IF NOT EXISTS ext_storyboard_asset_update_version_new
      AFTER UPDATE ON o_assets2Storyboard
      BEGIN
        INSERT INTO ext_entity_state (
          entityType, entityId, projectId, version, reviewState, locked, lockedBy, updatedBy, updatedAt, internalMutation
        )
        SELECT '${ENTITY_TYPE}', storyboard.id, script.projectId, 1, 'draft', 0, NULL, NULL,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
        FROM o_storyboard AS storyboard
        JOIN o_script AS script ON script.id = storyboard.scriptId
        WHERE storyboard.id = NEW.storyboardId
        ON CONFLICT(entityType, entityId) DO UPDATE SET
          projectId = excluded.projectId,
          version = ext_entity_state.version + 1,
          reviewState = 'draft',
          updatedBy = NULL,
          updatedAt = excluded.updatedAt;
      END;
    `),
    db.raw(`
      CREATE TRIGGER IF NOT EXISTS ext_storyboard_asset_update_version_old
      AFTER UPDATE ON o_assets2Storyboard
      WHEN OLD.storyboardId IS NOT NEW.storyboardId
      BEGIN
        INSERT INTO ext_entity_state (
          entityType, entityId, projectId, version, reviewState, locked, lockedBy, updatedBy, updatedAt, internalMutation
        )
        SELECT '${ENTITY_TYPE}', storyboard.id, script.projectId, 1, 'draft', 0, NULL, NULL,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
        FROM o_storyboard AS storyboard
        JOIN o_script AS script ON script.id = storyboard.scriptId
        WHERE storyboard.id = OLD.storyboardId
        ON CONFLICT(entityType, entityId) DO UPDATE SET
          projectId = excluded.projectId,
          version = ext_entity_state.version + 1,
          reviewState = 'draft',
          updatedBy = NULL,
          updatedAt = excluded.updatedAt;
      END;
    `),
  ]);
}

async function ensureProductionStatePostgresSchema(db: Knex.Transaction): Promise<void> {
  await db.raw(`
    CREATE TABLE IF NOT EXISTS "ext_entity_state" (
      "entityType" text NOT NULL,
      "entityId" bigint NOT NULL,
      "projectId" bigint NOT NULL,
      "version" bigint NOT NULL DEFAULT 0,
      "reviewState" text NOT NULL DEFAULT 'draft',
      "locked" smallint NOT NULL DEFAULT 0,
      "lockedBy" text,
      "updatedBy" text,
      "updatedAt" bigint,
      "internalMutation" text,
      PRIMARY KEY ("entityType", "entityId")
    )
  `);
  await db.raw(`CREATE INDEX IF NOT EXISTS "ext_entity_state_project_entity_idx" ON "ext_entity_state" ("projectId", "entityType")`);
  await db.raw(`
    CREATE OR REPLACE FUNCTION production_state_raise_if_locked() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE old_id bigint; new_id bigint;
    BEGIN
      IF TG_OP = 'DELETE' THEN old_id := OLD.id; new_id := NULL;
      ELSIF TG_OP = 'INSERT' THEN old_id := NULL; new_id := NEW.id;
      ELSE old_id := OLD.id; new_id := NEW.id;
      END IF;
      IF EXISTS (SELECT 1 FROM "ext_entity_state" WHERE "entityType" = 'storyboard' AND "entityId" IN (old_id, new_id) AND "locked" = 1) THEN
        RAISE EXCEPTION 'storyboard is locked' USING ERRCODE = '55000';
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END;
    $$
  `);
  await db.raw(`
    CREATE OR REPLACE FUNCTION production_state_raise_if_linked_locked() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE old_id bigint; new_id bigint;
    BEGIN
      IF TG_OP = 'DELETE' THEN old_id := OLD."storyboardId"; new_id := NULL;
      ELSIF TG_OP = 'INSERT' THEN old_id := NULL; new_id := NEW."storyboardId";
      ELSE old_id := OLD."storyboardId"; new_id := NEW."storyboardId";
      END IF;
      IF EXISTS (SELECT 1 FROM "ext_entity_state" WHERE "entityType" = 'storyboard' AND "entityId" IN (old_id, new_id) AND "locked" = 1) THEN
        RAISE EXCEPTION 'storyboard is locked' USING ERRCODE = '55000';
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END;
    $$
  `);
  await db.raw(`
    CREATE OR REPLACE FUNCTION production_state_touch_storyboard(p_id bigint) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO "ext_entity_state" ("entityType", "entityId", "projectId", "version", "reviewState", "locked", "updatedAt")
      SELECT 'storyboard', storyboard.id, script."projectId", 1, 'draft', 0, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
      FROM "o_storyboard" storyboard JOIN "o_script" script ON script.id = storyboard."scriptId"
      WHERE storyboard.id = p_id
      ON CONFLICT ("entityType", "entityId") DO UPDATE SET
        "projectId" = EXCLUDED."projectId", "version" = "ext_entity_state"."version" + 1,
        "reviewState" = 'draft', "updatedBy" = NULL, "updatedAt" = EXCLUDED."updatedAt";
    END;
    $$
  `);
  await db.raw(`
    CREATE OR REPLACE FUNCTION production_state_storyboard_after_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD IS DISTINCT FROM NEW AND NOT EXISTS (
        SELECT 1 FROM "ext_entity_state" WHERE "entityType" = 'storyboard' AND "entityId" = NEW.id AND "internalMutation" IS NOT NULL
      ) THEN PERFORM production_state_touch_storyboard(NEW.id); END IF;
      RETURN NEW;
    END;
    $$
  `);
  await db.raw(`
    CREATE OR REPLACE FUNCTION production_state_storyboard_after_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN DELETE FROM "ext_entity_state" WHERE "entityType" = 'storyboard' AND "entityId" = OLD.id; RETURN OLD; END;
    $$
  `);
  await db.raw(`
    CREATE OR REPLACE FUNCTION production_state_link_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE old_id bigint; new_id bigint;
    BEGIN
      IF TG_OP = 'DELETE' THEN old_id := OLD."storyboardId"; new_id := NULL;
      ELSIF TG_OP = 'INSERT' THEN old_id := NULL; new_id := NEW."storyboardId";
      ELSE old_id := OLD."storyboardId"; new_id := NEW."storyboardId";
      END IF;
      IF new_id IS NOT NULL THEN PERFORM production_state_touch_storyboard(new_id); END IF;
      IF old_id IS NOT NULL AND old_id IS DISTINCT FROM new_id THEN PERFORM production_state_touch_storyboard(old_id); END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END;
    $$
  `);
  for (const statement of [
    `DROP TRIGGER IF EXISTS ext_storyboard_reject_locked_update ON "o_storyboard"`,
    `DROP TRIGGER IF EXISTS ext_storyboard_reject_locked_delete ON "o_storyboard"`,
    `DROP TRIGGER IF EXISTS ext_storyboard_legacy_version ON "o_storyboard"`,
    `DROP TRIGGER IF EXISTS ext_storyboard_delete_state ON "o_storyboard"`,
    `DROP TRIGGER IF EXISTS ext_storyboard_asset_insert_locked ON "o_assets2Storyboard"`,
    `DROP TRIGGER IF EXISTS ext_storyboard_asset_update_locked ON "o_assets2Storyboard"`,
    `DROP TRIGGER IF EXISTS ext_storyboard_asset_delete_locked ON "o_assets2Storyboard"`,
    `DROP TRIGGER IF EXISTS ext_storyboard_asset_insert_version ON "o_assets2Storyboard"`,
    `DROP TRIGGER IF EXISTS ext_storyboard_asset_delete_version ON "o_assets2Storyboard"`,
    `DROP TRIGGER IF EXISTS ext_storyboard_asset_update_version_new ON "o_assets2Storyboard"`,
    `DROP TRIGGER IF EXISTS ext_storyboard_asset_update_version_old ON "o_assets2Storyboard"`,
    `DROP TRIGGER IF EXISTS ext_storyboard_asset_version ON "o_assets2Storyboard"`,
  ]) await db.raw(statement);
  await db.raw(`CREATE TRIGGER ext_storyboard_reject_locked_update BEFORE UPDATE ON "o_storyboard" FOR EACH ROW EXECUTE FUNCTION production_state_raise_if_locked()`);
  await db.raw(`CREATE TRIGGER ext_storyboard_reject_locked_delete BEFORE DELETE ON "o_storyboard" FOR EACH ROW EXECUTE FUNCTION production_state_raise_if_locked()`);
  await db.raw(`CREATE TRIGGER ext_storyboard_legacy_version AFTER UPDATE ON "o_storyboard" FOR EACH ROW EXECUTE FUNCTION production_state_storyboard_after_update()`);
  await db.raw(`CREATE TRIGGER ext_storyboard_delete_state AFTER DELETE ON "o_storyboard" FOR EACH ROW EXECUTE FUNCTION production_state_storyboard_after_delete()`);
  await db.raw(`CREATE TRIGGER ext_storyboard_asset_insert_locked BEFORE INSERT ON "o_assets2Storyboard" FOR EACH ROW EXECUTE FUNCTION production_state_raise_if_linked_locked()`);
  await db.raw(`CREATE TRIGGER ext_storyboard_asset_update_locked BEFORE UPDATE ON "o_assets2Storyboard" FOR EACH ROW EXECUTE FUNCTION production_state_raise_if_linked_locked()`);
  await db.raw(`CREATE TRIGGER ext_storyboard_asset_delete_locked BEFORE DELETE ON "o_assets2Storyboard" FOR EACH ROW EXECUTE FUNCTION production_state_raise_if_linked_locked()`);
  await db.raw(`CREATE TRIGGER ext_storyboard_asset_version AFTER INSERT OR UPDATE OR DELETE ON "o_assets2Storyboard" FOR EACH ROW EXECUTE FUNCTION production_state_link_after_change()`);
}

function isPostgres(db: Knex): boolean {
  return String((db.client as any)?.config?.client).toLowerCase() === "pg";
}

export class ProductionStateService {
  private readonly now: () => number;

  constructor(
    private readonly db: Knex,
    options: ProductionStateServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  private async runTransaction<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.db.transaction(work);
      } catch (error) {
        lastError = error;
        if (!this.isSqliteBusy(error) || attempt === 3) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  /** Reads without creating an extension row, so an untouched entity remains version 0. */
  async getStoryboardState(projectId: number, storyboardId: number): Promise<StoryboardWithState> {
    this.assertEntityReference(projectId, storyboardId);
    return this.runTransaction(async (trx) => {
      if (isPostgres(this.db)) await trx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const storyboard = await this.findStoryboardInProject(trx, projectId, storyboardId);
      const state = await this.readState(trx, projectId, storyboardId);
      return { storyboard, state };
    });
  }

  async updateStoryboardContent(input: UpdateStoryboardContentInput): Promise<StoryboardWithState> {
    this.assertActor(input.actor);
    this.assertContentPatch(input.patch);
    return this.runTransaction(async (trx) => {
      const context = await this.getMutationContext(trx, input.projectId, input.storyboardId, input.expectedVersion);
      if (context.state.locked) {
        throw new ProductionStateError("LOCKED", "Locked storyboards cannot be edited");
      }

      const changed = STORYBOARD_CONTENT_COLUMNS.some((column) =>
        Object.prototype.hasOwnProperty.call(input.patch, column) && context.storyboard[column] !== input.patch[column],
      );
      if (!changed) return context;

      const token = this.newMutationToken();
      const statePatch: StatePatch = {
        ...(context.state.reviewState === "approved" ? { reviewState: "draft" } : {}),
        updatedBy: input.actor.id,
        updatedAt: this.now(),
        internalMutation: token,
      };
      // Reserve the version before writing the legacy record. The marker makes
      // the DB-level legacy trigger skip this service write, avoiding a double bump.
      const state = await this.compareAndSwapState(trx, context.state, input.expectedVersion, statePatch);
      await trx("o_storyboard").where({ id: input.storyboardId }).update(input.patch);
      const released = await trx("ext_entity_state")
        .where({ entityType: ENTITY_TYPE, entityId: input.storyboardId, internalMutation: token })
        .update({ internalMutation: null });
      if (released !== 1) throw new ProductionStateError("VERSION_CONFLICT", "Storyboard state reservation was lost");
      return { storyboard: { ...context.storyboard, ...input.patch }, state };
    });
  }

  async setReviewState(input: ChangeReviewStateInput): Promise<StoryboardWithState> {
    this.assertActor(input.actor);
    this.requireHuman(input.actor, "Only a human can change review state");
    this.assertReviewState(input.reviewState);
    return this.runTransaction(async (trx) => {
      const context = await this.getMutationContext(trx, input.projectId, input.storyboardId, input.expectedVersion);
      if (context.state.reviewState === input.reviewState) return context;
      const state = await this.compareAndSwapState(trx, context.state, input.expectedVersion, {
        reviewState: input.reviewState,
        updatedBy: input.actor.id,
        updatedAt: this.now(),
      });
      return { storyboard: context.storyboard, state };
    });
  }

  async acquireLock(input: ChangeLockInput): Promise<StoryboardWithState> {
    this.assertActor(input.actor);
    this.requireHuman(input.actor, "Only a human can lock a storyboard");
    return this.runTransaction(async (trx) => {
      const context = await this.getMutationContext(trx, input.projectId, input.storyboardId, input.expectedVersion);
      if (context.storyboard.state === "生成中") {
        throw new ProductionStateError("LOCKED", "A generating storyboard cannot be locked");
      }
      if (await this.hasGeneratingReferencedAsset(trx, input.storyboardId)) {
        throw new ProductionStateError("LOCKED", "A referenced asset image is still generating");
      }
      if (context.state.locked) {
        if (context.state.lockedBy === input.actor.id) return context;
        throw new ProductionStateError("LOCKED", "Storyboard is locked by another user");
      }
      const state = await this.compareAndSwapState(trx, context.state, input.expectedVersion, {
        locked: true,
        lockedBy: input.actor.id,
        updatedBy: input.actor.id,
        updatedAt: this.now(),
      });
      return { storyboard: context.storyboard, state };
    });
  }

  async releaseLock(input: ChangeLockInput): Promise<StoryboardWithState> {
    this.assertActor(input.actor);
    this.requireHuman(input.actor, "Only a human can unlock a storyboard");
    return this.runTransaction(async (trx) => {
      const context = await this.getMutationContext(trx, input.projectId, input.storyboardId, input.expectedVersion);
      if (!context.state.locked) return context;
      if (context.state.lockedBy !== input.actor.id) {
        throw new ProductionStateError("FORBIDDEN", "Only the human who owns the lock can release it");
      }
      const state = await this.compareAndSwapState(trx, context.state, input.expectedVersion, {
        locked: false,
        lockedBy: null,
        updatedBy: input.actor.id,
        updatedAt: this.now(),
      });
      return { storyboard: context.storyboard, state };
    });
  }

  /**
   * Guard legacy batch/delete callbacks. The callback receives a single
   * transaction only after every storyboard has been bound to this project,
   * checked for an unlocked state, and checked against its supplied version.
   * Database triggers advance extension versions for raw legacy updates and
   * remove extension state when a storyboard is deleted.
   */
  async guardStoryboardMutations<T>(args: {
    projectId: number;
    storyboardIds: number[];
    expectedVersions: Record<number, number>;
    actor: TrustedActor;
    mutate: (trx: Knex.Transaction, storyboards: StoryboardWithState[]) => Promise<T>;
  }): Promise<T> {
    this.assertActor(args.actor);
    this.assertProjectId(args.projectId);
    const ids = [...new Set(args.storyboardIds)];
    if (!ids.length) throw new ProductionStateError("INVALID_INPUT", "At least one storyboard is required");
    return this.runTransaction(async (trx) => {
      const contexts = await Promise.all(
        ids.map(async (storyboardId) => {
          const expectedVersion = args.expectedVersions[storyboardId];
          if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
            throw new ProductionStateError("INVALID_INPUT", `Missing expectedVersion for storyboard ${storyboardId}`);
          }
          const context = await this.getMutationContext(trx, args.projectId, storyboardId, expectedVersion);
          if (context.state.locked) throw new ProductionStateError("LOCKED", `Storyboard ${storyboardId} is locked`);
          return context;
        }),
      );
      return args.mutate(trx, contexts);
    });
  }

  private async getMutationContext(
    trx: Knex.Transaction,
    projectId: number,
    storyboardId: number,
    expectedVersion: number,
  ): Promise<StoryboardContext> {
    this.assertEntityReference(projectId, storyboardId);
    this.assertExpectedVersion(expectedVersion);
    await lockProjectTransaction(trx, projectId);
    const storyboard = await this.findStoryboardInProject(trx, projectId, storyboardId, true);
    const state = await this.ensureState(trx, projectId, storyboardId);
    if (state.version !== expectedVersion) {
      throw new ProductionStateError("VERSION_CONFLICT", "The storyboard was changed by another client");
    }
    return { storyboard, state };
  }

  private async findStoryboardInProject(db: DbLike, projectId: number, storyboardId: number, lock = false): Promise<StoryboardRecord> {
    const query = db("o_storyboard as storyboard")
      .join("o_script as script", "script.id", "storyboard.scriptId")
      .where("storyboard.id", storyboardId)
      .select("storyboard.*", "script.projectId as _boundProjectId");
    if (lock && isPostgres(this.db)) query.forUpdate();
    const storyboard = await query.first();
    if (!storyboard) throw new ProductionStateError("NOT_FOUND", "Storyboard does not exist");
    if (Number(storyboard._boundProjectId) !== projectId) {
      throw new ProductionStateError("PROJECT_MISMATCH", "Storyboard is not bound to this project");
    }
    delete storyboard._boundProjectId;
    return storyboard as StoryboardRecord;
  }

  private async hasGeneratingReferencedAsset(trx: Knex.Transaction, storyboardId: number): Promise<boolean> {
    const generating = await trx("o_assets2Storyboard as relation")
      .join("o_assets as asset", "asset.id", "relation.assetId")
      .join("o_image as image", "image.id", "asset.imageId")
      .where("relation.storyboardId", storyboardId)
      .where("image.state", "生成中")
      .select("image.id")
      .first();
    return Boolean(generating);
  }

  private async readState(db: DbLike, projectId: number, storyboardId: number): Promise<ProductionEntityState> {
    const row = await db<StateRow>("ext_entity_state")
      .where({ entityType: ENTITY_TYPE, entityId: storyboardId, projectId })
      .first();
    return row ? this.toState(row) : this.defaultState(projectId, storyboardId);
  }

  private async ensureState(trx: Knex.Transaction, projectId: number, storyboardId: number): Promise<ProductionEntityState> {
    await trx("ext_entity_state")
      .insert({ entityType: ENTITY_TYPE, entityId: storyboardId, projectId, version: 0, reviewState: "draft", locked: 0 })
      .onConflict(["entityType", "entityId"])
      .ignore();
    const row = await trx<StateRow>("ext_entity_state")
      .where({ entityType: ENTITY_TYPE, entityId: storyboardId, projectId })
      .modify((query) => { if (isPostgres(this.db)) query.forUpdate(); })
      .first();
    const state = row ? this.toState(row) : this.defaultState(projectId, storyboardId);
    if (state.projectId !== projectId) {
      throw new ProductionStateError("PROJECT_MISMATCH", "State is bound to another project");
    }
    return state;
  }

  private async compareAndSwapState(
    trx: Knex.Transaction,
    current: ProductionEntityState,
    expectedVersion: number,
    patch: StatePatch,
  ): Promise<ProductionEntityState> {
    const nextVersion = expectedVersion + 1;
    const dbPatch = patch.locked === undefined ? patch : { ...patch, locked: patch.locked ? 1 : 0 };
    const changed = await trx("ext_entity_state")
      .where({ entityType: ENTITY_TYPE, entityId: current.entityId, projectId: current.projectId, version: expectedVersion })
      .update({ ...dbPatch, version: nextVersion });
    if (changed !== 1) throw new ProductionStateError("VERSION_CONFLICT", "The storyboard was changed by another client");
    const { internalMutation: _internalMutation, ...publicPatch } = patch;
    return {
      ...current,
      ...publicPatch,
      version: nextVersion,
      locked: patch.locked === undefined ? current.locked : Boolean(patch.locked),
      lockedBy: patch.lockedBy === undefined ? current.lockedBy : patch.lockedBy,
      updatedBy: patch.updatedBy === undefined ? current.updatedBy : patch.updatedBy,
      updatedAt: patch.updatedAt === undefined ? current.updatedAt : patch.updatedAt,
      reviewState: (patch.reviewState ?? current.reviewState) as ReviewState,
    };
  }

  private defaultState(projectId: number, storyboardId: number): ProductionEntityState {
    return {
      entityType: ENTITY_TYPE,
      entityId: storyboardId,
      projectId,
      version: 0,
      reviewState: "draft",
      locked: false,
      lockedBy: null,
      updatedBy: null,
      updatedAt: null,
    };
  }

  private toState(row: StateRow): ProductionEntityState {
    return {
      entityType: ENTITY_TYPE,
      entityId: Number(row.entityId),
      projectId: Number(row.projectId),
      version: Number(row.version),
      reviewState: row.reviewState,
      locked: Boolean(row.locked),
      lockedBy: row.lockedBy,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }

  private assertExpectedVersion(expectedVersion: number): void {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new ProductionStateError("INVALID_INPUT", "expectedVersion must be a non-negative integer");
    }
  }

  private assertEntityReference(projectId: number, storyboardId: number): void {
    this.assertProjectId(projectId);
    if (!Number.isSafeInteger(storyboardId) || storyboardId <= 0) {
      throw new ProductionStateError("INVALID_INPUT", "storyboardId must be a positive safe integer");
    }
  }

  private assertProjectId(projectId: number): void {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      throw new ProductionStateError("INVALID_INPUT", "projectId must be a positive safe integer");
    }
  }

  private assertContentPatch(patch: UpdateStoryboardContentInput["patch"]): void {
    const keys = Object.keys(patch);
    if (!keys.length || keys.some((key) => !STORYBOARD_CONTENT_COLUMNS.includes(key as (typeof STORYBOARD_CONTENT_COLUMNS)[number]))) {
      throw new ProductionStateError("INVALID_INPUT", "Only prompt and videoDesc can be changed through this service");
    }
    if (Object.values(patch).some((value) => value !== null && typeof value !== "string")) {
      throw new ProductionStateError("INVALID_INPUT", "Storyboard content values must be strings or null");
    }
  }

  private requireHuman(actor: TrustedActor, message: string): void {
    if (actor.kind !== "human") throw new ProductionStateError("FORBIDDEN", message);
  }

  private assertActor(actor: TrustedActor): void {
    if (!actor || typeof actor.id !== "string" || !actor.id.trim() || !["human", "agent", "system"].includes(actor.kind)) {
      throw new ProductionStateError("INVALID_INPUT", "A trusted actor with an id and valid kind is required");
    }
  }

  private assertReviewState(reviewState: ReviewState): void {
    if (!(["draft", "pending", "approved", "revision"] as string[]).includes(reviewState)) {
      throw new ProductionStateError("INVALID_INPUT", "Unknown review state");
    }
  }

  private newMutationToken(): string {
    return `${this.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private isSqliteBusy(error: unknown): boolean {
    return error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
  }
}
