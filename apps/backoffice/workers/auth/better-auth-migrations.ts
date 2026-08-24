import { sql, type Kysely } from "kysely";

import betterAuthSchemaSql from "./migrations/better-auth.sql?raw";

/** Current application-owned Better Auth schema version stored by the Auth Durable Object. */
export const BACKOFFICE_BETTER_AUTH_SCHEMA_VERSION = "better-auth-v1";

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

/** Applies the committed Better Auth SQL schema to a fresh database. */
export async function applyBackofficeBetterAuthSchemaMigrations<Database>(
  database: Kysely<Database>,
  installedVersion: string | null,
): Promise<void> {
  if (installedVersion === BACKOFFICE_BETTER_AUTH_SCHEMA_VERSION) {
    return;
  }
  if (installedVersion !== null) {
    throw new Error(
      `Backoffice Better Auth schema version '${installedVersion}' has no migration path.`,
    );
  }

  for (const statement of readBetterAuthGeneratedMigrationStatements(betterAuthSchemaSql)) {
    await sql.raw(statement).execute(database);
  }
}
