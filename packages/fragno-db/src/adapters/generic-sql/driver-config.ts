import { DatabaseConstraintError, DatabaseTransactionError } from "../../errors";
import {
  schemaNamingStrategy,
  suffixNamingStrategy,
  type SqlNamingStrategy,
} from "../../naming/sql-naming";

export const supportedDatabases = ["sqlite", "postgresql", "mysql"] as const;
export type SupportedDatabase = (typeof supportedDatabases)[number];

export const supportedDriverTypes = [
  "sqlocal",
  "cloudflare_durable_objects",
  "better-sqlite3",
  "pg",
  "pglite",
  "mysql2",
] as const;

export type SupportedDriverType = (typeof supportedDriverTypes)[number];

export abstract class DriverConfig<T extends SupportedDriverType = SupportedDriverType> {
  abstract readonly driverType: T;
  abstract readonly databaseType: SupportedDatabase;

  abstract readonly supportsReturning: boolean;
  abstract readonly supportsJson: boolean;
  abstract readonly outboxVersionstampStrategy: OutboxVersionstampStrategy;

  /**
   * Column name for internal ID in RETURNING results.
   * Only defined if supportsReturning is true.
   */
  abstract readonly internalIdColumn: string | undefined;

  /**
   * SQLite storage selection is handled by adapters, not driver config.
   */
  get supportsRowsAffected(): boolean {
    return !!this.extractAffectedRows;
  }

  get defaultNamingStrategy(): SqlNamingStrategy {
    return defaultNamingStrategyForDatabase(this.databaseType);
  }

  /**
   * Extract the number of affected rows from a query result.
   * Only implemented for drivers that support affected rows reporting.
   *
   * @param result - The query result from the SQL driver
   * @returns The number of affected rows as bigint
   * @throws Error if affected rows information is not found in the result
   */
  extractAffectedRows?(result: Record<string, unknown>): bigint;

  abstract normalizeError(error: unknown): Error;
}

function parseSqliteUniqueColumns(message: string): { table?: string; columns?: string[] } {
  const match = /^UNIQUE constraint failed: (.+)$/.exec(message);
  if (!match) {
    return {};
  }

  const refs = match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const columns = refs
    .map((ref) => ref.split(".").pop())
    .filter((column): column is string => !!column);
  const table = refs[0]?.split(".").slice(0, -1).join(".") || undefined;
  return { table, columns };
}

function parsePostgresDetailColumns(detail: unknown): string[] | undefined {
  if (typeof detail !== "string") {
    return undefined;
  }
  const match = /^Key \(([^)]+)\)=/.exec(detail);
  return match?.[1]
    ?.split(",")
    .map((column) => column.trim())
    .filter(Boolean);
}

function normalizePostgresError(error: unknown): Error {
  if (!error || typeof error !== "object") {
    return new Error(typeof error === "string" ? error : "UNKNOWN_DATABASE_ERROR");
  }

  const { code, table, constraint, column, detail } = error as Record<string, unknown>;
  const tableName = typeof table === "string" ? table : undefined;
  const constraintName = typeof constraint === "string" ? constraint : undefined;

  if (code === "40001" || code === "40P01") {
    return new DatabaseTransactionError({
      message: error instanceof Error ? error.message : "Database transaction conflict.",
      retryable: true,
      cause: error,
    });
  }

  if (code === "23505") {
    return new DatabaseConstraintError({
      kind: "unique",
      table: tableName,
      constraint: constraintName,
      columns: parsePostgresDetailColumns(detail),
      cause: error,
    });
  }
  if (code === "23503") {
    return new DatabaseConstraintError({
      kind: "foreign-key",
      table: tableName,
      constraint: constraintName,
      cause: error,
    });
  }
  if (code === "23502") {
    return new DatabaseConstraintError({
      kind: "not-null",
      table: tableName,
      constraint: constraintName,
      columns: typeof column === "string" ? [column] : undefined,
      cause: error,
    });
  }
  if (code === "23514") {
    return new DatabaseConstraintError({
      kind: "check",
      table: tableName,
      constraint: constraintName,
      cause: error,
    });
  }

  return error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : "UNKNOWN_DATABASE_ERROR");
}

function normalizeSqliteError(error: unknown): Error {
  if (!error || typeof error !== "object") {
    return new Error(typeof error === "string" ? error : "UNKNOWN_DATABASE_ERROR");
  }

  const { code, resultCode } = error as Record<string, unknown>;
  const message = error instanceof Error ? error.message : undefined;

  if (
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    resultCode === 2067 ||
    resultCode === 1555 ||
    message?.startsWith("UNIQUE constraint failed:")
  ) {
    const parsed = message ? parseSqliteUniqueColumns(message) : {};
    return new DatabaseConstraintError({ kind: "unique", ...parsed, cause: error });
  }
  if (
    code === "SQLITE_CONSTRAINT_FOREIGNKEY" ||
    resultCode === 787 ||
    message?.includes("FOREIGN KEY constraint failed")
  ) {
    return new DatabaseConstraintError({ kind: "foreign-key", cause: error });
  }
  if (
    code === "SQLITE_CONSTRAINT_NOTNULL" ||
    resultCode === 1299 ||
    message?.includes("NOT NULL constraint failed")
  ) {
    return new DatabaseConstraintError({ kind: "not-null", cause: error });
  }
  if (
    code === "SQLITE_CONSTRAINT_CHECK" ||
    resultCode === 275 ||
    message?.includes("CHECK constraint failed")
  ) {
    return new DatabaseConstraintError({ kind: "check", cause: error });
  }

  return error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : "UNKNOWN_DATABASE_ERROR");
}

function normalizeMysqlError(error: unknown): Error {
  if (!error || typeof error !== "object") {
    return new Error(typeof error === "string" ? error : "UNKNOWN_DATABASE_ERROR");
  }

  const { code, errno } = error as Record<string, unknown>;

  if (code === "ER_LOCK_DEADLOCK" || errno === 1213) {
    return new DatabaseTransactionError({ retryable: true, cause: error });
  }
  if (code === "ER_LOCK_WAIT_TIMEOUT" || errno === 1205) {
    return new DatabaseTransactionError({ retryable: true, cause: error });
  }
  if (code === "ER_DUP_ENTRY" || errno === 1062) {
    return new DatabaseConstraintError({ kind: "unique", cause: error });
  }
  if (errno === 1451 || errno === 1452) {
    return new DatabaseConstraintError({ kind: "foreign-key", cause: error });
  }
  if (code === "ER_BAD_NULL_ERROR" || errno === 1048) {
    return new DatabaseConstraintError({ kind: "not-null", cause: error });
  }

  return error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : "UNKNOWN_DATABASE_ERROR");
}

export const defaultNamingStrategyForDatabase = (
  databaseType: SupportedDatabase,
): SqlNamingStrategy => {
  switch (databaseType) {
    case "postgresql":
      return schemaNamingStrategy;
    case "sqlite":
    case "mysql":
    default:
      return suffixNamingStrategy;
  }
};

export type OutboxVersionstampStrategy =
  | "update-returning"
  | "insert-on-conflict-returning"
  | "insert-on-duplicate-last-insert-id";

export class SQLocalDriverConfig extends DriverConfig<"sqlocal"> {
  override readonly driverType = "sqlocal";
  override readonly databaseType = "sqlite";
  override readonly supportsReturning = true;
  override readonly supportsJson = false;
  override readonly internalIdColumn = "_internalId";
  override readonly outboxVersionstampStrategy = "insert-on-conflict-returning";

  override normalizeError(error: unknown): Error {
    return normalizeSqliteError(error);
  }
}

export class CloudflareDurableObjectsDriverConfig extends DriverConfig<"cloudflare_durable_objects"> {
  override readonly driverType = "cloudflare_durable_objects";
  override readonly databaseType = "sqlite";
  override readonly supportsReturning = true;
  override readonly supportsJson = false;
  override readonly internalIdColumn = "_internalId";
  override readonly outboxVersionstampStrategy = "insert-on-conflict-returning";

  override normalizeError(error: unknown): Error {
    return normalizeSqliteError(error);
  }
}

export class BetterSQLite3DriverConfig extends DriverConfig<"better-sqlite3"> {
  override readonly driverType = "better-sqlite3";
  override readonly databaseType = "sqlite";
  override readonly supportsReturning = true;
  override readonly supportsJson = false;
  override readonly internalIdColumn = "_internalId";
  override readonly outboxVersionstampStrategy = "insert-on-conflict-returning";

  override normalizeError(error: unknown): Error {
    return normalizeSqliteError(error);
  }

  override extractAffectedRows(result: Record<string, unknown>): bigint {
    if ("numAffectedRows" in result) {
      const value = result["numAffectedRows"];
      if (typeof value === "bigint") {
        return value;
      }
      if (typeof value === "number") {
        return BigInt(value);
      }
    }

    throw new Error(
      `No affected rows found in result: ${JSON.stringify(result)}. Driver ${this.driverType} is expected to support affected rows.`,
    );
  }
}

export class NodePostgresDriverConfig extends DriverConfig<"pg"> {
  override readonly driverType = "pg";
  override readonly databaseType = "postgresql";
  override readonly supportsReturning = true;
  override readonly supportsJson = true;
  override readonly internalIdColumn = "_internalId";
  override readonly outboxVersionstampStrategy = "insert-on-conflict-returning";

  override normalizeError(error: unknown): Error {
    return normalizePostgresError(error);
  }

  override extractAffectedRows(result: Record<string, unknown>): bigint {
    if ("numAffectedRows" in result) {
      const value = result["numAffectedRows"];
      if (typeof value === "bigint") {
        return value;
      }
      if (typeof value === "number") {
        return BigInt(value);
      }
    }
    if ("numChangedRows" in result) {
      const value = result["numChangedRows"];
      if (typeof value === "bigint") {
        return value;
      }
      if (typeof value === "number") {
        return BigInt(value);
      }
    }
    throw new Error(
      `No affected rows found in result: ${JSON.stringify(result)}. Driver ${this.driverType} is expected to support affected rows.`,
    );
  }
}

export class PGLiteDriverConfig extends DriverConfig<"pglite"> {
  override readonly driverType = "pglite";
  override readonly databaseType = "postgresql";
  override readonly supportsReturning = true;
  override readonly supportsJson = true;
  override readonly internalIdColumn = "_internalId";
  override readonly outboxVersionstampStrategy = "insert-on-conflict-returning";

  override normalizeError(error: unknown): Error {
    return normalizePostgresError(error);
  }

  override extractAffectedRows(result: Record<string, unknown>): bigint {
    if ("affectedRows" in result) {
      const value = result["affectedRows"];
      if (typeof value === "bigint") {
        return value;
      }
      if (typeof value === "number") {
        return BigInt(value);
      }
    }
    throw new Error(
      `No affected rows found in result: ${JSON.stringify(result)}. Driver ${this.driverType} is expected to support affected rows.`,
    );
  }
}

export class MySQL2DriverConfig extends DriverConfig<"mysql2"> {
  override readonly driverType = "mysql2";
  override readonly databaseType = "mysql";
  override readonly supportsReturning = false;
  override readonly supportsJson = true;
  override readonly internalIdColumn = undefined;
  override readonly outboxVersionstampStrategy = "insert-on-duplicate-last-insert-id";

  override normalizeError(error: unknown): Error {
    return normalizeMysqlError(error);
  }

  override extractAffectedRows(result: Record<string, unknown>): bigint {
    const value = result["numAffectedRows"];
    if (typeof value === "bigint") {
      return value;
    }
    if (typeof value === "number") {
      return BigInt(value);
    }
    throw new Error(
      `No affected rows found in result: ${JSON.stringify(result)}. Driver ${this.driverType} is expected to support affected rows.`,
    );
  }
}
