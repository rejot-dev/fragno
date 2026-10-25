import { afterEach, describe, expect, test } from "vitest";

import { getMigrations } from "better-auth/db/migration";
import Database from "better-sqlite3";
import { Kysely, sql, SqliteDialect } from "kysely";

import {
  applyBackofficeBetterAuthSchemaMigrations,
  BACKOFFICE_BETTER_AUTH_SCHEMA_VERSION,
} from "./better-auth-migrations";
import { createBackofficeBetterAuthSchemaPlugins } from "./better-auth-schema-plugins";
import betterAuthSchemaSql from "./migrations/better-auth.sql?raw";

const databases: Kysely<unknown>[] = [];

function createMigrationDatabase(): Kysely<unknown> {
  const database = new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new Database(":memory:") }),
  });
  databases.push(database);
  return database;
}

const NO_SCHEMA_CHANGES = {
  toBeCreated: [],
  toBeAdded: [],
  toBeAddedIndexes: [],
  unsafeChanges: [],
};

/** What Better Auth would still change to reach the schema the runtime plugins declare. */
async function pendingSchemaChanges(database: Kysely<unknown>) {
  const migrationPlan = await getMigrations({
    appName: "Fragno Backoffice",
    baseURL: "http://localhost",
    basePath: "/api/auth",
    secret: "backoffice-auth-schema-verification-secret",
    database: { db: database, type: "sqlite", transaction: true },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 100,
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, trustedProviders: ["github"] },
    },
    plugins: createBackofficeBetterAuthSchemaPlugins({
      baseURL: "http://localhost",
      organizationHooks: null,
      isUserAdministrator: null,
      listFirstPartyOAuthClientIds: null,
    }),
  });
  return {
    toBeCreated: migrationPlan.toBeCreated,
    toBeAdded: migrationPlan.toBeAdded,
    toBeAddedIndexes: migrationPlan.toBeAddedIndexes,
    unsafeChanges: migrationPlan.unsafeChanges,
  };
}

/**
 * Every table's columns, foreign keys, and indexes. Better Auth's migration plan misses an index
 * absent from an existing table, so upgrades are compared with this instead.
 */
async function describeSchema(database: Kysely<unknown>) {
  const result = await sql<Record<string, unknown>>`
    SELECT m.name AS "table", 'column' AS kind, c.name, c.type, c."notnull" AS detail
    FROM sqlite_master m, pragma_table_info(m.name) c
    WHERE m.type = 'table'
    UNION ALL
    SELECT m.name, 'foreign key', f."from", f."table", f.on_delete
    FROM sqlite_master m, pragma_foreign_key_list(m.name) f
    WHERE m.type = 'table'
    UNION ALL
    SELECT m.name, 'index', i.name, i."unique", i.origin
    FROM sqlite_master m, pragma_index_list(m.name) i
    WHERE m.type = 'table'
    ORDER BY 1, 2, 3
  `.execute(database);
  return result.rows;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (database) => await database.destroy()));
});

describe("Backoffice Better Auth SQL migrations", () => {
  test("creates the current schema from an unversioned database", async () => {
    const database = createMigrationDatabase();

    await database.transaction().execute(async (transaction) => {
      await applyBackofficeBetterAuthSchemaMigrations(transaction, null);
    });

    const tables = await sql<{ name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `.execute(database);

    expect(tables.rows.map(({ name }) => name)).toEqual([
      "account",
      "deviceCode",
      "invitation",
      "jwks",
      "member",
      "oauthAccessToken",
      "oauthClient",
      "oauthClientAssertion",
      "oauthClientResource",
      "oauthConsent",
      "oauthRefreshToken",
      "oauthResource",
      "organization",
      "session",
      "user",
      "verification",
    ]);
  });

  test("matches the schema declared by the runtime Better Auth plugins", async () => {
    const database = createMigrationDatabase();
    await applyBackofficeBetterAuthSchemaMigrations(database, null);

    expect(await pendingSchemaChanges(database)).toEqual(NO_SCHEMA_CHANGES);
  });

  test("upgrades a v2 database to the schema a new database gets", async () => {
    const database = createMigrationDatabase();
    // v2 is the committed schema before organizations could be managed.
    const v2Schema = betterAuthSchemaSql
      .replace(
        ',\n  "managingOrganizationId" text REFERENCES "organization" ("id") ON DELETE SET NULL',
        "",
      )
      .replace(
        'CREATE INDEX "organization_managingOrganizationId_idx" ON "organization" ("managingOrganizationId");\n\n',
        "",
      );
    expect(v2Schema).not.toContain("managingOrganizationId");
    for (const statement of v2Schema.trim().slice(0, -1).split(/;\n\n/u)) {
      await sql.raw(statement).execute(database);
    }

    await applyBackofficeBetterAuthSchemaMigrations(database, "better-auth-v2");

    const fresh = createMigrationDatabase();
    await applyBackofficeBetterAuthSchemaMigrations(fresh, null);
    expect(await describeSchema(database)).toEqual(await describeSchema(fresh));
  });

  test("rejects an installed schema version without a committed migration path", async () => {
    const database = createMigrationDatabase();

    await expect(
      applyBackofficeBetterAuthSchemaMigrations(database, "better-auth-unknown"),
    ).rejects.toThrow(
      "Backoffice Better Auth schema version 'better-auth-unknown' has no migration path.",
    );
    expect(BACKOFFICE_BETTER_AUTH_SCHEMA_VERSION).toBe("better-auth-v3");
  });
});
