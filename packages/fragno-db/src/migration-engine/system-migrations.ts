import type { AnySchema } from "../schema/create";
import type { NamingResolver } from "../naming/sql-naming";
import type { MigrationOperation } from "./shared";

export interface SystemMigrationContext {
  schema: AnySchema;
  namespace: string;
  resolver?: NamingResolver;
  /**
   * Optional table set to scope system migrations.
   * When provided, only these tables will be considered.
   */
  tables?: AnySchema["tables"];
}

export type SystemMigration = (
  context: SystemMigrationContext,
) => string | string[] | undefined | void;

export function resolveSystemMigrationRange(
  migrations: SystemMigration[],
  systemFromVersion: number | undefined,
  systemToVersion?: number,
): { fromVersion: number; toVersion: number } | null {
  if (systemFromVersion === undefined) {
    if (systemToVersion !== undefined) {
      throw new Error("systemToVersion requires systemFromVersion.");
    }
    return null;
  }

  if (systemFromVersion < 0) {
    throw new Error(`systemFromVersion cannot be negative: ${systemFromVersion}`);
  }

  const targetVersion = systemToVersion ?? migrations.length;

  if (targetVersion < 0) {
    throw new Error(`systemToVersion cannot be negative: ${targetVersion}`);
  }

  if (targetVersion < systemFromVersion) {
    throw new Error(
      `Cannot migrate system versions backwards: from ${systemFromVersion} to ${targetVersion}`,
    );
  }

  if (systemFromVersion > migrations.length) {
    throw new Error(
      `systemFromVersion (${systemFromVersion}) exceeds system migrations length (${migrations.length})`,
    );
  }

  if (targetVersion > migrations.length) {
    throw new Error(
      `systemToVersion (${targetVersion}) exceeds system migrations length (${migrations.length})`,
    );
  }

  return { fromVersion: systemFromVersion, toVersion: targetVersion };
}

export function buildSystemMigrationOperations(
  migrations: SystemMigration[],
  context: SystemMigrationContext,
  fromVersion: number,
  toVersion: number,
): MigrationOperation[] {
  if (fromVersion === toVersion) {
    return [];
  }

  const ops: MigrationOperation[] = [];
  const slice = migrations.slice(fromVersion, toVersion);

  for (const migration of slice) {
    const result = migration(context);
    const statements = typeof result === "string" ? [result] : (result ?? []);
    for (const statement of statements) {
      if (!statement || statement.trim().length === 0) {
        continue;
      }
      ops.push({ type: "custom", sql: statement });
    }
  }

  return ops;
}

export function resolveSystemMigrationTables(
  schema: AnySchema,
  fromVersion: number,
): AnySchema["tables"] {
  if (fromVersion <= 0) {
    return {};
  }

  const tableNames = new Set<string>();
  const appliedOperations = schema.operations.slice(0, fromVersion);

  for (const op of appliedOperations) {
    if (op.type === "add-table") {
      tableNames.add(op.tableName);
    }
  }

  const tables: AnySchema["tables"] = {};
  for (const name of tableNames) {
    const table = schema.tables[name];
    if (table) {
      tables[name] = table;
    }
  }

  return tables;
}
