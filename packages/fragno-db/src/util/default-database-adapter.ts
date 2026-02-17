import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { SqliteDialect } from "kysely";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
import type { DatabaseAdapter } from "../adapters/adapters";
import type { AnySchema } from "../schema/create";
type DatabaseAdapterConfig = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  databaseAdapter?: DatabaseAdapter<any>;
  databaseNamespace?: string | null;
};

type BetterSqlite3Constructor = typeof import("better-sqlite3");

const isCloudflareWorkers = (): boolean => {
  if (typeof globalThis === "undefined") {
    return false;
  }
  const navigatorRef = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  return navigatorRef?.userAgent === "Cloudflare-Workers";
};

const createNodeRequire = (): NodeRequire | null => {
  try {
    const metaUrl = typeof import.meta !== "undefined" ? import.meta.url : undefined;
    if (!metaUrl || typeof metaUrl !== "string") {
      return null;
    }
    return createRequire(metaUrl);
  } catch {
    return null;
  }
};

const loadBetterSqlite3 = (): BetterSqlite3Constructor | null => {
  if (isCloudflareWorkers()) {
    return null;
  }
  const requireFn = createNodeRequire();
  if (!requireFn) {
    return null;
  }
  try {
    const module = requireFn("better-sqlite3");
    return (module.default ?? module) as BetterSqlite3Constructor;
  } catch {
    return null;
  }
};

const betterSqlite3Constructor = loadBetterSqlite3();

const defaultDataDir = (): string => {
  const configured = process.env["FRAGNO_DATA_DIR"];
  if (configured && configured.trim().length > 0) {
    return configured;
  }
  return path.join(process.env["HOME"] ?? process.cwd(), ".fragno");
};

const sanitizeFileSegment = (name: string): string => {
  const sanitized = name.replace(/[^a-z0-9-]/gi, "_");
  return sanitized.length > 0 ? sanitized : "fragno";
};

const resolveSqliteDatabasePath = <TSchema extends AnySchema>(
  options: DatabaseAdapterConfig,
  schema: TSchema,
): string => {
  const baseName =
    typeof options.databaseNamespace === "string" && options.databaseNamespace.length > 0
      ? options.databaseNamespace
      : schema.name;
  const fileName = `${sanitizeFileSegment(baseName)}.sqlite`;
  return path.join(defaultDataDir(), fileName);
};

const createDefaultSqliteAdapter = <TSchema extends AnySchema>(
  options: DatabaseAdapterConfig,
  schema: TSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): DatabaseAdapter<any> | null => {
  if (!betterSqlite3Constructor) {
    return null;
  }

  const dbPath = resolveSqliteDatabasePath(options, schema);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const dialect = new SqliteDialect({
    database: new betterSqlite3Constructor(dbPath),
  });
  const driverConfig = new BetterSQLite3DriverConfig();
  return new SqlAdapter({ dialect, driverConfig });
};

export const resolveDatabaseAdapter = <TSchema extends AnySchema>(
  options: DatabaseAdapterConfig,
  schema: TSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): DatabaseAdapter<any> => {
  if (options.databaseAdapter) {
    return options.databaseAdapter;
  }

  const defaultAdapter = createDefaultSqliteAdapter(options, schema);
  if (!defaultAdapter) {
    throw new Error(
      "Database fragment requires options.databaseAdapter, or install better-sqlite3 to use the default SQLite adapter.",
    );
  }

  options.databaseAdapter = defaultAdapter;
  return defaultAdapter;
};
