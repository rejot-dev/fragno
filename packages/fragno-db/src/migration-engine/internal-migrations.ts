import type { AnySchema } from "../schema/create";
import type { NamingResolver } from "../naming/sql-naming";
import type { MigrationOperation } from "./shared";

export interface InternalMigrationContext {
  schema: AnySchema;
  namespace: string;
  resolver?: NamingResolver;
}

export type InternalMigration = (
  context: InternalMigrationContext,
) => string | string[] | undefined | void;

export function resolveInternalMigrationRange(
  migrations: InternalMigration[],
  internalFromVersion: number | undefined,
  internalToVersion?: number,
): { fromVersion: number; toVersion: number } | null {
  if (internalFromVersion === undefined) {
    if (internalToVersion !== undefined) {
      throw new Error("internalToVersion requires internalFromVersion.");
    }
    return null;
  }

  if (internalFromVersion < 0) {
    throw new Error(`internalFromVersion cannot be negative: ${internalFromVersion}`);
  }

  const targetVersion = internalToVersion ?? migrations.length;

  if (targetVersion < 0) {
    throw new Error(`internalToVersion cannot be negative: ${targetVersion}`);
  }

  if (targetVersion < internalFromVersion) {
    throw new Error(
      `Cannot migrate internal versions backwards: from ${internalFromVersion} to ${targetVersion}`,
    );
  }

  if (internalFromVersion > migrations.length) {
    throw new Error(
      `internalFromVersion (${internalFromVersion}) exceeds internal migrations length (${migrations.length})`,
    );
  }

  if (targetVersion > migrations.length) {
    throw new Error(
      `internalToVersion (${targetVersion}) exceeds internal migrations length (${migrations.length})`,
    );
  }

  return { fromVersion: internalFromVersion, toVersion: targetVersion };
}

export function buildInternalMigrationOperations(
  migrations: InternalMigration[],
  context: InternalMigrationContext,
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
