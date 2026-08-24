import { afterEach, describe, expect, test } from "vitest";

import { getMigrations } from "better-auth/db/migration";
import Database from "better-sqlite3";
import { Kysely, sql, SqliteDialect } from "kysely";

import {
  applyBackofficeBetterAuthSchemaMigrations,
  BACKOFFICE_BETTER_AUTH_SCHEMA_VERSION,
} from "./better-auth-migrations";
import { createBackofficeBetterAuthSchemaPlugins } from "./better-auth-schema-plugins";

const databases: Kysely<unknown>[] = [];

function createMigrationDatabase(): Kysely<unknown> {
  const database = new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new Database(":memory:") }),
  });
  databases.push(database);
  return database;
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
      }),
    });

    expect({
      toBeCreated: migrationPlan.toBeCreated,
      toBeAdded: migrationPlan.toBeAdded,
      toBeAddedIndexes: migrationPlan.toBeAddedIndexes,
      unsafeChanges: migrationPlan.unsafeChanges,
    }).toEqual({
      toBeCreated: [],
      toBeAdded: [],
      toBeAddedIndexes: [],
      unsafeChanges: [],
    });
  });

  test("rejects an installed schema version without a committed migration path", async () => {
    const database = createMigrationDatabase();

    await expect(
      applyBackofficeBetterAuthSchemaMigrations(database, "better-auth-unknown"),
    ).rejects.toThrow(
      "Backoffice Better Auth schema version 'better-auth-unknown' has no migration path.",
    );
    expect(BACKOFFICE_BETTER_AUTH_SCHEMA_VERSION).toBe("better-auth-v1");
  });
});
