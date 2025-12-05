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
import type { Kysely } from "kysely";
/**
 * Options for executing a migration.
 */
export interface ExecuteOptions {
  /**
   * Whether to automatically update the schema version in the database after migration.
   * If not specified, uses the value from PreparedMigrationsConfig.
   */
  updateVersionInMigration?: boolean;
}

/**
 * Interface for preparing and executing migrations.
 * Provides a clean separation between compilation (SQL generation) and execution.
 */
export interface PreparedMigrations {
  /**
   * Execute migration from one version to another.
   * This performs all three phases:
   * - Phase 1: schema → operations
   * - Phase 2: operations → SQL
   * - Phase 3: SQL → database
   *
   * @param fromVersion - Current database version (0 for new database)
   * @param toVersion - Target schema version (defaults to schema.version)
   * @param options - Optional execution options (overrides config defaults)
   */
  execute(fromVersion: number, toVersion?: number, options?: ExecuteOptions): Promise<void>;

  /**
   * Execute migration using a specific driver.
   * Useful for testing or when you need to use a different driver than the one provided in config.
   *
   * @param driver - SQL driver to use for execution
   * @param fromVersion - Current database version (0 for new database)
   * @param toVersion - Target schema version (defaults to schema.version)
   * @param options - Optional execution options (overrides config defaults)
   */
  executeWithDriver(
    driver: SqlDriverAdapter,
    fromVersion: number,
    toVersion?: number,
    options?: ExecuteOptions,
  ): Promise<void>;
}

/**
 * Configuration for creating a PreparedMigrations instance.
 */
export interface PreparedMigrationsConfig {
  schema: AnySchema;
  namespace: string;
  database: SupportedDatabase;
  mapper?: TableNameMapper;
  driver?: SqlDriverAdapter;
  /**
   * Whether to automatically update the schema version in the database after migration.
   * Defaults to true. Can be overridden per execution via ExecuteOptions.
   */
  updateVersionInMigration?: boolean;
}

/**
 * Create a PreparedMigrations instance for a schema and namespace.
 */
export function createPreparedMigrations(config: PreparedMigrationsConfig): PreparedMigrations {
  const {
    schema,
    namespace,
    database,
    driver,
    updateVersionInMigration: defaultUpdateVersion = true,
  } = config;

  // Create the cold Kysely instance for SQL generation
  const coldKysely = createColdKysely(database);

  // Create the appropriate SQL generator for the database
  const generator = createSQLGenerator(database, coldKysely);

  /**
   * Internal method to compile a migration for a given version range.
   */
  function compile(
    fromVersion: number,
    toVersion: number,
    updateVersionInMigration: boolean,
  ): CompiledMigration {
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
    const statements = generator.compile(operations, config.mapper);

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
  }

  return {
    async execute(fromVersion, toVersion, options) {
      if (!driver) {
        throw new Error(
          "Driver not provided. Cannot execute migration. Use `executeWithDriver` instead.",
        );
      }

      return this.executeWithDriver(driver, fromVersion, toVersion, options);
    },

    async executeWithDriver(driverToUse, fromVersion, toVersion, options) {
      // Use option if provided, otherwise use config default
      const updateVersionInMigration = options?.updateVersionInMigration ?? defaultUpdateVersion;
      const targetVersion = toVersion ?? schema.version;

      // Compile the migration (this will validate the version numbers)
      const migration = compile(fromVersion, targetVersion, updateVersionInMigration);

      // Execute the migration
      await executeMigration(driverToUse, migration);
    },
  };
}

/**
 * Create the appropriate SQL generator for a database type.
 */
function createSQLGenerator(
  database: SupportedDatabase,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  coldKysely: Kysely<any>,
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
