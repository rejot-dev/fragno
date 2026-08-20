import { sql, type Kysely } from "kysely";

export type BetterAuthDurableHookName =
  | "onUserCreated"
  | "onUserEmailVerificationRequested"
  | "onOrganizationCreated"
  | "onOrganizationUpdated";

export type BetterAuthDurableHookRow = {
  id: string;
  hookName: BetterAuthDurableHookName;
  payload: string;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: number | null;
  nextRetryAt: number | null;
  error: string | null;
  createdAt: number;
  propagationContext: string | null;
};

export type BetterAuthDurableHooksDatabase = {
  better_auth_hooks: BetterAuthDurableHookRow;
};

const CREATE_HOOKS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS better_auth_hooks (
    id TEXT PRIMARY KEY,
    hookName TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    maxAttempts INTEGER NOT NULL DEFAULT 10,
    lastAttemptAt INTEGER,
    nextRetryAt INTEGER,
    error TEXT,
    createdAt INTEGER NOT NULL,
    propagationContext TEXT
  )
`;

const CREATE_PENDING_INDEX_SQL = sql`
  CREATE INDEX IF NOT EXISTS better_auth_hooks_status_retry
  ON better_auth_hooks(status, nextRetryAt, createdAt, id)
`;

const CREATE_TERMINAL_INDEX_SQL = sql`
  CREATE INDEX IF NOT EXISTS better_auth_hooks_status_last_attempt
  ON better_auth_hooks(status, lastAttemptAt, id)
`;

const CREATE_CREATED_INDEX_SQL = sql`
  CREATE INDEX IF NOT EXISTS better_auth_hooks_created
  ON better_auth_hooks(createdAt, id)
`;

const RECOVER_INTERRUPTED_HOOKS_SQL = sql`
  UPDATE better_auth_hooks
  SET status = 'pending'
  WHERE status = 'processing'
`;

const CREATE_USER_TRIGGER_SQL = sql`
  CREATE TRIGGER IF NOT EXISTS better_auth_user_created_hook
  AFTER INSERT ON user
  BEGIN
    INSERT INTO better_auth_hooks (
      id,
      hookName,
      payload,
      nextRetryAt,
      createdAt
    ) VALUES (
      'user.created:' || NEW.id,
      'onUserCreated',
      json_object(
        'user', json_object(
          'id', NEW.id,
          'email', NEW.email,
          'name', NEW.name
        )
      ),
      unixepoch() * 1000,
      unixepoch() * 1000
    );
  END
`;

const CREATE_ORGANIZATION_TRIGGER_SQL = sql`
  CREATE TRIGGER IF NOT EXISTS better_auth_organization_created_hook
  AFTER INSERT ON organization
  BEGIN
    INSERT INTO better_auth_hooks (
      id,
      hookName,
      payload,
      nextRetryAt,
      createdAt
    ) VALUES (
      'organization.created:' || NEW.id,
      'onOrganizationCreated',
      json_object(
        'organization', json_object(
          'id', NEW.id,
          'name', NEW.name,
          'slug', NEW.slug,
          'logoUrl', NEW.logo,
          'metadata', json(NEW.metadata),
          'createdBy', NEW.createdBy,
          'createdAt', NEW.createdAt,
          'updatedAt', NEW.createdAt,
          'deletedAt', NULL
        ),
        'actor', NULL
      ),
      unixepoch() * 1000,
      unixepoch() * 1000
    );
  END
`;

const UPDATE_ORGANIZATION_TRIGGER_SQL = sql`
  CREATE TRIGGER IF NOT EXISTS better_auth_organization_updated_hook
  AFTER UPDATE OF name, slug, logo, metadata ON organization
  BEGIN
    INSERT INTO better_auth_hooks (
      id,
      hookName,
      payload,
      nextRetryAt,
      createdAt
    ) VALUES (
      'organization.updated:' || lower(hex(randomblob(16))),
      'onOrganizationUpdated',
      json_object(
        'organization', json_object(
          'id', NEW.id,
          'name', NEW.name,
          'slug', NEW.slug,
          'logoUrl', NEW.logo,
          'metadata', json(NEW.metadata),
          'createdBy', NEW.createdBy,
          'createdAt', NEW.createdAt,
          'updatedAt', unixepoch() * 1000,
          'deletedAt', NULL
        ),
        'actor', NULL
      ),
      unixepoch() * 1000,
      unixepoch() * 1000
    );
  END
`;

export async function removeBetterAuthDurableHookTriggers<
  Database extends BetterAuthDurableHooksDatabase,
>(database: Kysely<Database>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS better_auth_user_created_hook`.execute(database);
  await sql`DROP TRIGGER IF EXISTS better_auth_organization_created_hook`.execute(database);
  await sql`DROP TRIGGER IF EXISTS better_auth_organization_updated_hook`.execute(database);
}

// These triggers replace Better Auth `after` database hooks so the row mutation and durable-hook
// intent commit or roll back together. Do not move lifecycle delivery back into `after` hooks.
export async function installBetterAuthDurableHooks<
  Database extends BetterAuthDurableHooksDatabase,
>(database: Kysely<Database>): Promise<void> {
  await CREATE_HOOKS_TABLE_SQL.execute(database);
  await CREATE_PENDING_INDEX_SQL.execute(database);
  await CREATE_TERMINAL_INDEX_SQL.execute(database);
  await CREATE_CREATED_INDEX_SQL.execute(database);
  await RECOVER_INTERRUPTED_HOOKS_SQL.execute(database);
  await CREATE_USER_TRIGGER_SQL.execute(database);
  await CREATE_ORGANIZATION_TRIGGER_SQL.execute(database);
  await UPDATE_ORGANIZATION_TRIGGER_SQL.execute(database);
}

export async function insertBetterAuthDurableHook<Database extends BetterAuthDurableHooksDatabase>(
  database: Kysely<Database>,
  input: {
    id: string;
    hookName: BetterAuthDurableHookName;
    payload: string;
    maxAttempts: number;
    propagationContext: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO better_auth_hooks (
      id, hookName, payload, status, attempts, maxAttempts,
      lastAttemptAt, nextRetryAt, error, createdAt, propagationContext
    ) VALUES (
      ${input.id}, ${input.hookName}, ${input.payload}, 'pending', 0, ${input.maxAttempts},
      NULL, unixepoch() * 1000, NULL, unixepoch() * 1000, ${input.propagationContext}
    )
  `.execute(database);
}

export async function listDueBetterAuthDurableHooks<
  Database extends BetterAuthDurableHooksDatabase,
>(database: Kysely<Database>, input: { limit: number }): Promise<BetterAuthDurableHookRow[]> {
  const result = await sql<BetterAuthDurableHookRow>`
    SELECT
      id, hookName, payload, status, attempts, maxAttempts,
      lastAttemptAt, nextRetryAt, error, createdAt, propagationContext
    FROM better_auth_hooks
    WHERE status = 'pending' AND nextRetryAt <= unixepoch() * 1000
    ORDER BY nextRetryAt ASC, createdAt ASC, id ASC
    LIMIT ${input.limit}
  `.execute(database);
  return result.rows;
}

export async function markBetterAuthDurableHookProcessing<
  Database extends BetterAuthDurableHooksDatabase,
>(database: Kysely<Database>, input: { id: string }): Promise<void> {
  await sql`
    UPDATE better_auth_hooks
    SET status = 'processing', attempts = attempts + 1, lastAttemptAt = unixepoch() * 1000
    WHERE id = ${input.id}
  `.execute(database);
}

export async function completeBetterAuthDurableHook<
  Database extends BetterAuthDurableHooksDatabase,
>(database: Kysely<Database>, input: { id: string }): Promise<void> {
  await sql`
    UPDATE better_auth_hooks
    SET status = 'completed', lastAttemptAt = unixepoch() * 1000, nextRetryAt = NULL, error = NULL
    WHERE id = ${input.id}
  `.execute(database);
}

export async function retryBetterAuthDurableHook<Database extends BetterAuthDurableHooksDatabase>(
  database: Kysely<Database>,
  input: {
    id: string;
    retryDelayMs: number;
    error: string;
    terminal: boolean;
  },
): Promise<void> {
  await sql`
    UPDATE better_auth_hooks
    SET
      status = ${input.terminal ? "failed" : "pending"},
      lastAttemptAt = unixepoch() * 1000,
      nextRetryAt = ${input.terminal ? null : sql`unixepoch() * 1000 + ${input.retryDelayMs}`},
      error = ${input.error}
    WHERE id = ${input.id}
  `.execute(database);
}

export async function findNextBetterAuthDurableHookWakeAt<
  Database extends BetterAuthDurableHooksDatabase,
>(database: Kysely<Database>, input: { wakeImmediately: boolean }): Promise<number | null> {
  const result = input.wakeImmediately
    ? await sql<{ nextRetryAt: number }>`
        SELECT unixepoch() * 1000 AS nextRetryAt
      `.execute(database)
    : await sql<{ nextRetryAt: number | null }>`
        SELECT MIN(nextRetryAt) AS nextRetryAt
        FROM better_auth_hooks
        WHERE status = 'pending'
      `.execute(database);
  return result.rows[0]?.nextRetryAt ?? null;
}

export async function deleteBetterAuthDurableHooksForFixture<
  Database extends BetterAuthDurableHooksDatabase,
>(
  database: Kysely<Database>,
  input: { userIds: readonly string[]; organizationIds: readonly string[] },
): Promise<void> {
  await sql`
    DELETE FROM better_auth_hooks
    WHERE
      (hookName = 'onUserCreated' AND json_extract(payload, '$.user.id') IN (
        SELECT value FROM json_each(${JSON.stringify(input.userIds)})
      ))
      OR
      (hookName IN ('onOrganizationCreated', 'onOrganizationUpdated')
        AND json_extract(payload, '$.organization.id') IN (
          SELECT value FROM json_each(${JSON.stringify(input.organizationIds)})
        ))
  `.execute(database);
}

export async function listBetterAuthDurableHooks<Database extends BetterAuthDurableHooksDatabase>(
  database: Kysely<Database>,
  input: { cursor: string | null; limit: number },
): Promise<BetterAuthDurableHookRow[]> {
  const result = input.cursor
    ? await sql<BetterAuthDurableHookRow>`
        SELECT
          id, hookName, payload, status, attempts, maxAttempts,
          lastAttemptAt, nextRetryAt, error, createdAt, propagationContext
        FROM better_auth_hooks
        WHERE (createdAt, id) > (
          SELECT createdAt, id FROM better_auth_hooks WHERE id = ${input.cursor}
        )
        ORDER BY createdAt ASC, id ASC
        LIMIT ${input.limit}
      `.execute(database)
    : await sql<BetterAuthDurableHookRow>`
        SELECT
          id, hookName, payload, status, attempts, maxAttempts,
          lastAttemptAt, nextRetryAt, error, createdAt, propagationContext
        FROM better_auth_hooks
        ORDER BY createdAt ASC, id ASC
        LIMIT ${input.limit}
      `.execute(database);
  return result.rows;
}

export async function getBetterAuthDurableHook<Database extends BetterAuthDurableHooksDatabase>(
  database: Kysely<Database>,
  id: string,
): Promise<BetterAuthDurableHookRow | null> {
  const result = await sql<BetterAuthDurableHookRow>`
    SELECT
      id, hookName, payload, status, attempts, maxAttempts,
      lastAttemptAt, nextRetryAt, error, createdAt, propagationContext
    FROM better_auth_hooks
    WHERE id = ${id}
    LIMIT 1
  `.execute(database);
  return result.rows[0] ?? null;
}

export async function deleteRetainedBetterAuthDurableHooks<
  Database extends BetterAuthDurableHooksDatabase,
>(database: Kysely<Database>, input: { retentionMs: number }): Promise<number> {
  const result = await sql`
    DELETE FROM better_auth_hooks
    WHERE id IN (
      SELECT id
      FROM better_auth_hooks
      WHERE
        status IN ('completed', 'failed')
        AND lastAttemptAt < unixepoch() * 1000 - ${input.retentionMs}
      ORDER BY lastAttemptAt ASC, id ASC
      LIMIT 100
    )
  `.execute(database);
  return Number(result.numAffectedRows ?? 0);
}
