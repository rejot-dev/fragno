// Test database adapter helpers and reset logic for fragment suites.
import { Kysely } from "kysely";
import { SQLocalKysely } from "sqlocal/kysely";
import { KyselyPGlite } from "kysely-pglite";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { KyselyAdapter } from "@fragno-dev/db/adapters/kysely";
import { InMemoryAdapter, type InMemoryAdapterOptions } from "@fragno-dev/db/adapters/in-memory";
import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import type { AnySchema } from "@fragno-dev/db/schema";
import type { DatabaseAdapter } from "@fragno-dev/db/adapters";
import type { UnitOfWorkConfig } from "@fragno-dev/db/adapters/generic-sql";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { BaseTestContext } from ".";
import { ModelCheckerAdapter } from "./model-checker-adapter";
import { createCommonTestContextMethods } from ".";
import { PGLiteDriverConfig, SQLocalDriverConfig } from "@fragno-dev/db/drivers";
import { internalFragmentDef } from "@fragno-dev/db";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";

// Adapter configuration types
export interface KyselySqliteAdapter {
  type: "kysely-sqlite";
  uowConfig?: UnitOfWorkConfig;
}

export interface KyselyPgliteAdapter {
  type: "kysely-pglite";
  databasePath?: string;
  uowConfig?: UnitOfWorkConfig;
}

export interface DrizzlePgliteAdapter {
  type: "drizzle-pglite";
  databasePath?: string;
  uowConfig?: UnitOfWorkConfig;
}

export interface InMemoryAdapterConfig {
  type: "in-memory";
  options?: InMemoryAdapterOptions;
  uowConfig?: UnitOfWorkConfig;
}

export interface ModelCheckerAdapterConfig {
  type: "model-checker";
  options?: InMemoryAdapterOptions;
}

export type SupportedAdapter =
  | KyselySqliteAdapter
  | KyselyPgliteAdapter
  | DrizzlePgliteAdapter
  | InMemoryAdapterConfig
  | ModelCheckerAdapterConfig;

// Schema configuration for multi-schema adapters
export interface SchemaConfig {
  schema: AnySchema;
  namespace: string;
  migrateToVersion?: number;
}

// Internal test context extends BaseTestContext with getOrm (not exposed publicly)
interface InternalTestContext extends BaseTestContext {
  getOrm: <TSchema extends AnySchema>(namespace: string) => SimpleQueryInterface<TSchema>;
}

// Conditional return types based on adapter (adapter-specific properties only)
export type AdapterContext<T extends SupportedAdapter> = T extends
  | KyselySqliteAdapter
  | KyselyPgliteAdapter
  ? {
      readonly kysely: Kysely<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  : T extends DrizzlePgliteAdapter
    ? {
        readonly drizzle: ReturnType<typeof drizzle<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
      }
    : T extends InMemoryAdapterConfig | ModelCheckerAdapterConfig
      ? {}
      : never;

// Factory function return type
interface AdapterFactoryResult<T extends SupportedAdapter> {
  testContext: InternalTestContext & AdapterContext<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: DatabaseAdapter<any>;
}

/**
 * Create Kysely + SQLite adapter using SQLocalKysely (always in-memory)
 * Supports multiple schemas with separate namespaces
 */
export async function createKyselySqliteAdapter(
  config: KyselySqliteAdapter,
  schemas: SchemaConfig[],
): Promise<AdapterFactoryResult<KyselySqliteAdapter>> {
  // Helper to create a new database instance and run migrations for all schemas
  const createDatabase = async () => {
    // Create SQLocalKysely instance (always in-memory for tests)
    const { dialect } = new SQLocalKysely(":memory:");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kysely = new Kysely<any>({
      dialect,
    });

    // Create KyselyAdapter
    const adapter = new KyselyAdapter({
      dialect,
      driverConfig: new SQLocalDriverConfig(),
      uowConfig: config.uowConfig,
    });

    // Run migrations for all schemas in order
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ormMap = new Map<string, SimpleQueryInterface<any, any>>();

    for (const { schema, namespace, migrateToVersion } of schemas) {
      // Run migrations
      const preparedMigrations = adapter.prepareMigrations(schema, namespace);
      if (migrateToVersion !== undefined) {
        await preparedMigrations.execute(0, migrateToVersion, { updateVersionInMigration: false });
      } else {
        await preparedMigrations.execute(0, schema.version, { updateVersionInMigration: false });
      }

      // Create ORM instance and store in map
      const orm = adapter.createQueryEngine(schema, namespace);
      ormMap.set(namespace, orm);
    }

    return { kysely, adapter, ormMap };
  };

  // Create initial database
  let { kysely, adapter, ormMap } = await createDatabase();

  // Reset database function - truncates all tables (only supported for in-memory databases)
  const resetDatabase = async () => {
    // For SQLite, truncate all tables by deleting rows
    for (const { schema, namespace } of schemas) {
      const mapper = adapter.createTableNameMapper(namespace);
      for (const tableName of Object.keys(schema.tables)) {
        const physicalTableName = mapper.toPhysical(tableName);
        await kysely.deleteFrom(physicalTableName).execute();
      }
    }
  };

  // Cleanup function - closes connections (no files to delete for in-memory)
  const cleanup = async () => {
    await kysely.destroy();
  };

  const commonMethods = createCommonTestContextMethods(ormMap);

  return {
    testContext: {
      get kysely() {
        return kysely;
      },
      get adapter() {
        return adapter;
      },
      ...commonMethods,
      resetDatabase,
      cleanup,
    },
    get adapter() {
      return adapter;
    },
  };
}

/**
 * Create Kysely + PGLite adapter using kysely-pglite
 * Supports multiple schemas with separate namespaces
 */
export async function createKyselyPgliteAdapter(
  config: KyselyPgliteAdapter,
  schemas: SchemaConfig[],
): Promise<AdapterFactoryResult<KyselyPgliteAdapter>> {
  const databasePath = config.databasePath;

  // Helper to create a new database instance and run migrations for all schemas
  const createDatabase = async () => {
    // Create KyselyPGlite instance
    const kyselyPglite = await KyselyPGlite.create(databasePath);

    // Create Kysely instance with PGlite dialect
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kysely = new Kysely<any>({
      dialect: kyselyPglite.dialect,
    });

    // Create KyselyAdapter
    const adapter = new KyselyAdapter({
      dialect: kyselyPglite.dialect,
      driverConfig: new PGLiteDriverConfig(),
      uowConfig: config.uowConfig,
    });

    // Run migrations for all schemas in order
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ormMap = new Map<string, SimpleQueryInterface<any, any>>();

    for (const { schema, namespace, migrateToVersion } of schemas) {
      // Run migrations
      const preparedMigrations = adapter.prepareMigrations(schema, namespace);
      if (migrateToVersion !== undefined) {
        await preparedMigrations.execute(0, migrateToVersion, { updateVersionInMigration: false });
      } else {
        await preparedMigrations.execute(0, schema.version, { updateVersionInMigration: false });
      }

      // Create ORM instance and store in map
      const orm = adapter.createQueryEngine(schema, namespace);
      ormMap.set(namespace, orm);
    }

    return { kysely, adapter, kyselyPglite, ormMap };
  };

  // Create initial database
  const { kysely, adapter, kyselyPglite, ormMap } = await createDatabase();

  // Reset database function - truncates all tables (only supported for in-memory databases)
  const resetDatabase = async () => {
    if (databasePath && databasePath !== ":memory:") {
      throw new Error("resetDatabase is only supported for in-memory databases");
    }

    // Truncate all tables
    for (const { schema, namespace } of schemas) {
      const mapper = adapter.createTableNameMapper(namespace);
      for (const tableName of Object.keys(schema.tables)) {
        const physicalTableName = mapper.toPhysical(tableName);
        await kysely.deleteFrom(physicalTableName).execute();
      }
    }
  };

  // Cleanup function - closes connections and deletes database directory
  const cleanup = async () => {
    await kysely.destroy();

    try {
      await kyselyPglite.client.close();
    } catch {
      // Ignore if already closed
    }

    // Delete the database directory if it exists and is a file path
    if (databasePath && databasePath !== ":memory:" && existsSync(databasePath)) {
      await rm(databasePath, { recursive: true, force: true });
    }
  };

  const commonMethods = createCommonTestContextMethods(ormMap);

  return {
    testContext: {
      get kysely() {
        return kysely;
      },
      get adapter() {
        return adapter;
      },
      ...commonMethods,
      resetDatabase,
      cleanup,
    },
    get adapter() {
      return adapter;
    },
  };
}

/**
 * Create Drizzle + PGLite adapter using drizzle-orm/pglite
 * Supports multiple schemas with separate namespaces
 */
export async function createDrizzlePgliteAdapter(
  config: DrizzlePgliteAdapter,
  schemas: SchemaConfig[],
): Promise<AdapterFactoryResult<DrizzlePgliteAdapter>> {
  const databasePath = config.databasePath;

  // Helper to create a new database instance and run migrations for all schemas
  const createDatabase = async () => {
    const pglite = new PGlite(databasePath);

    const { dialect } = new KyselyPGlite(pglite);

    const adapter = new DrizzleAdapter({
      dialect,
      driverConfig: new PGLiteDriverConfig(),
      uowConfig: config.uowConfig,
    });

    // Run migrations for all schemas
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ormMap = new Map<string, SimpleQueryInterface<any, any>>();

    const databaseDeps = internalFragmentDef.dependencies?.({
      config: {},
      options: { databaseAdapter: adapter },
    });
    if (databaseDeps?.schema) {
      const migrations = adapter.prepareMigrations(databaseDeps.schema, databaseDeps.namespace);
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    for (const { schema, namespace, migrateToVersion } of schemas) {
      const preparedMigrations = adapter.prepareMigrations(schema, namespace);
      if (migrateToVersion !== undefined) {
        await preparedMigrations.execute(0, migrateToVersion, { updateVersionInMigration: false });
      } else {
        await preparedMigrations.execute(0, schema.version, { updateVersionInMigration: false });
      }

      // Create ORM instance and store in map
      const orm = adapter.createQueryEngine(schema, namespace);
      ormMap.set(namespace, orm);
    }

    // Create Drizzle instance for backward compatibility (if needed)
    const db = drizzle(pglite) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    return { drizzle: db, adapter, pglite, ormMap };
  };

  // Create initial database
  const { drizzle: drizzleDb, adapter, ormMap } = await createDatabase();

  // Reset database function - truncates all tables (only supported for in-memory databases)
  const resetDatabase = async () => {
    if (databasePath && databasePath !== ":memory:") {
      throw new Error("resetDatabase is only supported for in-memory databases");
    }

    // Truncate all tables by deleting rows
    for (const { schema, namespace } of schemas) {
      const mapper = adapter.createTableNameMapper(namespace);
      const tableNames = Object.keys(schema.tables).slice().reverse();
      for (const tableName of tableNames) {
        const physicalTableName = mapper.toPhysical(tableName);
        await drizzleDb.execute(`DELETE FROM "${physicalTableName}"`);
      }
    }
  };

  // Cleanup function - closes connections and deletes database directory
  const cleanup = async () => {
    // Close the adapter (which will handle closing the underlying database connection)
    await adapter.close();

    // Delete the database directory if it exists and is a file path
    if (databasePath && databasePath !== ":memory:" && existsSync(databasePath)) {
      await rm(databasePath, { recursive: true, force: true });
    }
  };

  const commonMethods = createCommonTestContextMethods(ormMap);

  return {
    testContext: {
      get drizzle() {
        return drizzleDb;
      },
      get adapter() {
        return adapter;
      },
      ...commonMethods,
      resetDatabase,
      cleanup,
    },
    get adapter() {
      return adapter;
    },
  };
}

/**
 * Create InMemory adapter (no migrations required).
 */
export async function createInMemoryAdapter(
  config: InMemoryAdapterConfig,
  schemas: SchemaConfig[],
): Promise<AdapterFactoryResult<InMemoryAdapterConfig>> {
  const adapter = new InMemoryAdapter(config.options);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ormMap = new Map<string, SimpleQueryInterface<any, any>>();
  for (const { schema, namespace } of schemas) {
    const orm = adapter.createQueryEngine(schema, namespace);
    ormMap.set(namespace, orm);
  }

  const resetDatabase = async () => {
    await adapter.reset();
  };

  const cleanup = async () => {
    await adapter.close();
  };

  const commonMethods = createCommonTestContextMethods(ormMap);

  return {
    testContext: {
      get adapter() {
        return adapter;
      },
      ...commonMethods,
      resetDatabase,
      cleanup,
    },
    get adapter() {
      return adapter;
    },
  };
}

/**
 * Create ModelChecker adapter (wraps the in-memory adapter).
 */
export async function createModelCheckerAdapter(
  config: ModelCheckerAdapterConfig,
  schemas: SchemaConfig[],
): Promise<AdapterFactoryResult<ModelCheckerAdapterConfig>> {
  const baseAdapter = new InMemoryAdapter(config.options);
  const adapter = new ModelCheckerAdapter(baseAdapter);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ormMap = new Map<string, SimpleQueryInterface<any, any>>();
  for (const { schema, namespace } of schemas) {
    const orm = adapter.createQueryEngine(schema, namespace);
    ormMap.set(namespace, orm);
  }

  const resetDatabase = async () => {
    await baseAdapter.reset();
  };

  const cleanup = async () => {
    await adapter.close();
  };

  const commonMethods = createCommonTestContextMethods(ormMap);

  return {
    testContext: {
      get adapter() {
        return adapter;
      },
      ...commonMethods,
      resetDatabase,
      cleanup,
    },
    get adapter() {
      return adapter;
    },
  };
}

/**
 * Create adapter based on configuration
 * Supports multiple schemas with separate namespaces
 */
export async function createAdapter<T extends SupportedAdapter>(
  adapterConfig: T,
  schemas: SchemaConfig[],
): Promise<AdapterFactoryResult<T>> {
  if (adapterConfig.type === "kysely-sqlite") {
    return createKyselySqliteAdapter(adapterConfig, schemas) as Promise<AdapterFactoryResult<T>>;
  } else if (adapterConfig.type === "kysely-pglite") {
    return createKyselyPgliteAdapter(adapterConfig, schemas) as Promise<AdapterFactoryResult<T>>;
  } else if (adapterConfig.type === "drizzle-pglite") {
    return createDrizzlePgliteAdapter(adapterConfig, schemas) as Promise<AdapterFactoryResult<T>>;
  } else if (adapterConfig.type === "in-memory") {
    return createInMemoryAdapter(adapterConfig, schemas) as Promise<AdapterFactoryResult<T>>;
  } else if (adapterConfig.type === "model-checker") {
    return createModelCheckerAdapter(adapterConfig, schemas) as Promise<AdapterFactoryResult<T>>;
  }

  throw new Error(`Unsupported adapter type: ${(adapterConfig as SupportedAdapter).type}`);
}
