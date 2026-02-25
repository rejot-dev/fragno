import type { AnySchema } from "../../../schema/create";
import type { SqlDriverAdapter } from "../../../sql-driver/sql-driver-adapter";
import type { NamingResolver } from "../../../naming/sql-naming";
import { generateMigrationFromSchema } from "../../../migration-engine/auto-from-schema";
import {
  buildSystemMigrationOperations,
  resolveSystemMigrationRange,
  resolveSystemMigrationTables,
  type SystemMigration,
} from "../../../migration-engine/system-migrations";
import { createColdKysely } from "./cold-kysely";
import { type SQLGenerator } from "./sql-generator";
import { SQLiteSQLGenerator } from "./dialect/sqlite";
import { PostgresSQLGenerator } from "./dialect/postgres";
import { MySQLSQLGenerator } from "./dialect/mysql";
import { postgresSystemMigrations } from "./dialect/postgres.system-migrations";
import { mysqlSystemMigrations } from "./dialect/mysql.system-migrations";
import { sqliteSystemMigrations } from "./dialect/sqlite.system-migrations";
import { executeMigration, type CompiledMigration } from "./executor";
import type { DriverConfig, SupportedDatabase } from "../driver-config";
import type { Kysely } from "kysely";
import type { SQLiteStorageMode } from "../sqlite-storage";
import { version as FRAGNO_DB_PACKAGE_VERSION } from "../../../../package.json";
/**
 * Options for executing a migration.
 */
export interface ExecuteOptions {
  /**
   * Whether to automatically update the schema version in the database after migration.
   * If not specified, uses the value from PreparedMigrationsConfig.
   */
  updateVersionInMigration?: boolean;

  /**
   * System migration version currently stored in the database.
   * If omitted, system migrations are skipped. System migrations are also skipped
   * on fresh databases (fromVersion = 0) while still updating the system version.
   */
  systemFromVersion?: number;

  /**
   * Override the target system migration version.
   * Defaults to the number of configured system migrations.
   */
  systemToVersion?: number;
}

export interface PrepareMigrationsOptions {
  /**
   * Override system migrations (useful for testing).
   */
  systemMigrations?: SystemMigration[];
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

  /**
   * Get the SQL for a migration from one version to another without executing it.
   * Useful for generating migration files or previewing changes.
   *
   * @param fromVersion - Current database version (0 for new database)
   * @param toVersion - Target schema version (defaults to schema.version)
   * @param options - Optional execution options (affects version update SQL)
   * @returns SQL string for the migration
   */
  getSQL(fromVersion: number, toVersion?: number, options?: ExecuteOptions): string;

  /**
   * Get the compiled migration for a version range.
   * Returns both the SQL statements and the version information.
   *
   * @param fromVersion - Current database version (0 for new database)
   * @param toVersion - Target schema version (defaults to schema.version)
   * @param options - Optional execution options (affects version update SQL)
   * @returns Compiled migration with statements and version info
   */
  compile(fromVersion: number, toVersion?: number, options?: ExecuteOptions): CompiledMigration;
}

/**
 * Configuration for creating a PreparedMigrations instance.
 */
export interface PreparedMigrationsConfig {
  schema: AnySchema;
  namespace: string;
  database: SupportedDatabase;
  driverConfig?: DriverConfig;
  sqliteStorageMode?: SQLiteStorageMode;
  resolver?: NamingResolver;
  driver?: SqlDriverAdapter;
  /**
   * System migrations for this dialect. Defaults to the built-in list.
   */
  systemMigrations?: SystemMigration[];
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
    driverConfig,
    sqliteStorageMode,
    driver,
    systemMigrations: systemMigrationsOverride,
    updateVersionInMigration: defaultUpdateVersion = true,
  } = config;

  // Create the cold Kysely instance for SQL generation
  const coldKysely = createColdKysely(database);

  // Create the appropriate SQL generator for the database
  const generator = createSQLGenerator(database, coldKysely, driverConfig, sqliteStorageMode);

  const systemMigrations = systemMigrationsOverride ?? getDefaultSystemMigrations(database);
  /**
   * Internal method to compile a migration for a given version range.
   */
  function compile(
    fromVersion: number,
    toVersion: number,
    updateVersionInMigration: boolean,
    systemFromVersion: number | undefined,
    systemToVersion: number | undefined,
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

    const isFreshDatabase = fromVersion === 0;

    // Phase 1: Generate migration operations from schema
    const operations = generateMigrationFromSchema(schema, fromVersion, toVersion);

    // Phase 1b: Append system migrations (if provided)
    const systemRange = resolveSystemMigrationRange(
      systemMigrations,
      systemFromVersion,
      systemToVersion,
    );
    const systemOperations =
      systemRange && !isFreshDatabase
        ? buildSystemMigrationOperations(
            systemMigrations,
            {
              schema,
              namespace,
              resolver: config.resolver,
              tables: resolveSystemMigrationTables(schema, fromVersion),
            },
            systemRange.fromVersion,
            systemRange.toVersion,
          )
        : [];

    // Phase 2: Compile operations to SQL
    const statements = generator.compile([...operations, ...systemOperations], config.resolver);

    // Add version update SQL if requested
    if (updateVersionInMigration && toVersion !== fromVersion) {
      const versionUpdate = generator.generateVersionUpdateSQL(namespace, fromVersion, toVersion);
      statements.push(versionUpdate);
    }

    if (
      updateVersionInMigration &&
      systemRange &&
      systemRange.toVersion !== systemRange.fromVersion
    ) {
      const systemVersionUpdate = generator.generateSystemMigrationUpdateSQL(
        namespace,
        systemRange.fromVersion,
        systemRange.toVersion,
      );
      statements.push(systemVersionUpdate);
    }

    if (updateVersionInMigration && namespace === "") {
      const packageVersionUpdate =
        generator.generatePackageVersionUpdateSQL(FRAGNO_DB_PACKAGE_VERSION);
      statements.push(packageVersionUpdate);
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
      const migration = compile(
        fromVersion,
        targetVersion,
        updateVersionInMigration,
        options?.systemFromVersion,
        options?.systemToVersion,
      );

      // Execute the migration
      await executeMigration(driverToUse, migration);
    },

    getSQL(fromVersion, toVersion, options) {
      const updateVersionInMigration = options?.updateVersionInMigration ?? defaultUpdateVersion;
      const targetVersion = toVersion ?? schema.version;

      const migration = compile(
        fromVersion,
        targetVersion,
        updateVersionInMigration,
        options?.systemFromVersion,
        options?.systemToVersion,
      );
      return migration.statements.map((stmt) => stmt.sql + ";").join("\n\n");
    },

    compile(fromVersion, toVersion, options) {
      const updateVersionInMigration = options?.updateVersionInMigration ?? defaultUpdateVersion;
      const targetVersion = toVersion ?? schema.version;

      return compile(
        fromVersion,
        targetVersion,
        updateVersionInMigration,
        options?.systemFromVersion,
        options?.systemToVersion,
      );
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
  driverConfig?: DriverConfig,
  sqliteStorageMode?: SQLiteStorageMode,
): SQLGenerator {
  switch (database) {
    case "sqlite":
      return new SQLiteSQLGenerator(coldKysely, database, driverConfig, sqliteStorageMode);
    case "postgresql":
      return new PostgresSQLGenerator(coldKysely, database, driverConfig, sqliteStorageMode);
    case "mysql":
      return new MySQLSQLGenerator(coldKysely, database, driverConfig, sqliteStorageMode);
  }
}

function getDefaultSystemMigrations(database: SupportedDatabase): SystemMigration[] {
  switch (database) {
    case "sqlite":
      return sqliteSystemMigrations;
    case "postgresql":
      return postgresSystemMigrations;
    case "mysql":
      return mysqlSystemMigrations;
  }
}
