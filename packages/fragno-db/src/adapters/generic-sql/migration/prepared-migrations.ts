import type { AnySchema } from "../../../schema/create";
import type { SqlDriverAdapter } from "../../../sql-driver/sql-driver-adapter";
import type { TableNameMapper } from "../../shared/table-name-mapper";
import { generateMigrationFromSchema } from "../../../migration-engine/auto-from-schema";
import { createColdKysely } from "./cold-kysely";
import { type SQLGenerator } from "./sql-generator";
import { SQLiteSQLGenerator } from "./dialect/sqlite";
import { PostgresSQLGenerator } from "./dialect/postgres";
import { MySQLSQLGenerator } from "./dialect/mysql";
import { executeMigration, type CompiledMigration } from "./executor";
import type { SupportedDatabase } from "../driver-config";

/**
 * Options for compiling a migration.
 */
export interface CompileOptions {
  fromVersion?: number;
  toVersion?: number;
  updateVersionInMigration?: boolean;
}

/**
 * Interface for preparing and executing migrations.
 * Provides a clean separation between compilation (SQL generation) and execution.
 */
export interface PreparedMigrations {
  /**
   * Compile migration operations to SQL statements.
   * This performs Phase 1 (schema → operations) and Phase 2 (operations → SQL).
   */
  compile(options?: CompileOptions): CompiledMigration;

  /**
   * Execute a compiled migration.
   * This performs Phase 3 (SQL → database).
   */
  execute(driver: SqlDriverAdapter, migration: CompiledMigration): Promise<void>;
}

/**
 * Configuration for creating a PreparedMigrations instance.
 */
export interface PreparedMigrationsConfig {
  schema: AnySchema;
  namespace: string;
  database: SupportedDatabase;
  mapper?: TableNameMapper;
}

/**
 * Create a PreparedMigrations instance for a schema and namespace.
 */
export function createPreparedMigrations(config: PreparedMigrationsConfig): PreparedMigrations {
  const { schema, namespace, database } = config;

  // Create the cold Kysely instance for SQL generation
  const coldKysely = createColdKysely(database);

  // Create the appropriate SQL generator for the database
  const generator = createSQLGenerator(database, coldKysely);

  // Use provided mapper or create default one if namespace is provided
  const mapper: TableNameMapper | undefined =
    config.mapper ??
    (namespace
      ? {
          toPhysical: (logicalName: string) => `${logicalName}_${namespace}`,
          toLogical: (physicalName: string) =>
            physicalName.endsWith(`_${namespace}`)
              ? physicalName.slice(0, -(namespace.length + 1))
              : physicalName,
        }
      : undefined);

  return {
    compile(options) {
      const {
        fromVersion = 0,
        toVersion = schema.version,
        updateVersionInMigration = false,
      } = options ?? {};

      // Validate version numbers
      if (fromVersion < 0) {
        throw new Error(`fromVersion cannot be negative: ${fromVersion}`);
      }
      if (toVersion < 0) {
        throw new Error(`toVersion cannot be negative: ${toVersion}`);
      }
      if (toVersion < fromVersion) {
        throw new Error(
          `Cannot migrate backwards: fromVersion (${fromVersion}) > toVersion (${toVersion})`,
        );
      }
      if (toVersion > schema.version) {
        throw new Error(`toVersion (${toVersion}) exceeds schema version (${schema.version})`);
      }

      // Phase 1: Generate migration operations from schema
      const operations = generateMigrationFromSchema(schema, fromVersion, toVersion);

      // Phase 2: Compile operations to SQL
      const statements = generator.compile(operations, mapper);

      // Add version update SQL if requested
      if (updateVersionInMigration && toVersion !== fromVersion) {
        const versionUpdate = generator.generateVersionUpdateSQL(namespace, fromVersion, toVersion);
        statements.push(versionUpdate);
      }

      return {
        statements,
        fromVersion,
        toVersion,
      };
    },

    async execute(driver, migration) {
      await executeMigration(driver, migration);
    },
  };
}

/**
 * Create the appropriate SQL generator for a database type.
 */
function createSQLGenerator(
  database: SupportedDatabase,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  coldKysely: any,
): SQLGenerator {
  switch (database) {
    case "sqlite":
      return new SQLiteSQLGenerator(coldKysely, database);
    case "postgresql":
      return new PostgresSQLGenerator(coldKysely, database);
    case "mysql":
      return new MySQLSQLGenerator(coldKysely, database);
  }
}
