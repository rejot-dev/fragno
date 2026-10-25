import { sql, type Kysely } from "kysely";

import betterAuthSchemaSql from "./migrations/better-auth.sql?raw";

/** Current application-owned Better Auth schema version stored by the Auth Durable Object. */
export const BACKOFFICE_BETTER_AUTH_SCHEMA_VERSION = "better-auth-v3";

function readBetterAuthGeneratedMigrationStatements(migrationSql: string): string[] {
  const trimmedMigration = migrationSql.trim();
  if (!trimmedMigration.endsWith(";")) {
    throw new Error("Better Auth generated migration must end with a semicolon.");
  }

  // Better Auth's SQL generator separates statements with a semicolon and one blank line.
  return trimmedMigration
    .slice(0, -1)
    .split(/;\r?\n\r?\n/u)
    .map((statement) => statement.trim());
}

/** v3 lets an organization be managed by another; the committed SQL creates it for new databases. */
async function addManagingOrganization<Database>(database: Kysely<Database>): Promise<void> {
  await sql`
    ALTER TABLE "organization"
    ADD COLUMN "managingOrganizationId" text REFERENCES "organization" ("id") ON DELETE SET NULL
  `.execute(database);
  await sql`
    CREATE INDEX "organization_managingOrganizationId_idx"
    ON "organization" ("managingOrganizationId")
  `.execute(database);
}

/** Applies the committed Better Auth SQL schema to a fresh database, or upgrades an older one. */
export async function applyBackofficeBetterAuthSchemaMigrations<Database>(
  database: Kysely<Database>,
  installedVersion: string | null,
): Promise<void> {
  switch (installedVersion) {
    case BACKOFFICE_BETTER_AUTH_SCHEMA_VERSION:
      return;
    // v2 added the password-reset outbox trigger, installed by installBetterAuthDurableHooks in
    // the same migration transaction, so v1 tables are v2 tables.
    case "better-auth-v1":
    case "better-auth-v2":
      await addManagingOrganization(database);
      return;
    case null:
      for (const statement of readBetterAuthGeneratedMigrationStatements(betterAuthSchemaSql)) {
        await sql.raw(statement).execute(database);
      }
      return;
    default:
      throw new Error(
        `Backoffice Better Auth schema version '${installedVersion}' has no migration path.`,
      );
  }
}
