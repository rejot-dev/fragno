import { Kysely } from "kysely";
import { SQLocalKysely } from "sqlocal/kysely";
import { KyselyPGlite } from "kysely-pglite";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { KyselyAdapter } from "@fragno-dev/db/adapters/kysely";
import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import type { AnySchema } from "@fragno-dev/db/schema";
import type { DatabaseAdapter } from "@fragno-dev/db/adapters";
import type { AbstractQuery } from "@fragno-dev/db/query";
import { createRequire } from "node:module";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { BaseTestContext } from ".";
import { createCommonTestContextMethods } from ".";

// Adapter configuration types
export interface KyselySqliteAdapter {
  type: "kysely-sqlite";
}

export interface KyselyPgliteAdapter {
  type: "kysely-pglite";
  databasePath?: string;
}

export interface DrizzlePgliteAdapter {
  type: "drizzle-pglite";
  databasePath?: string;
}

export type SupportedAdapter = KyselySqliteAdapter | KyselyPgliteAdapter | DrizzlePgliteAdapter;

// Schema configuration for multi-schema adapters
export interface SchemaConfig {
  schema: AnySchema;
  namespace: string;
  migrateToVersion?: number;
}

// Internal test context extends BaseTestContext with getOrm (not exposed publicly)
interface InternalTestContext extends BaseTestContext {
  getOrm: <TSchema extends AnySchema>(namespace: string) => AbstractQuery<TSchema>;
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
  _config: KyselySqliteAdapter,
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
      db: kysely,
      provider: "sqlite",
    });

    // Run migrations for all schemas in order
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ormMap = new Map<string, AbstractQuery<any, any>>();

    for (const { schema, namespace, migrateToVersion } of schemas) {
      // Run migrations
      const migrator = adapter.createMigrationEngine(schema, namespace);
      const preparedMigration = migrateToVersion
        ? await migrator.prepareMigrationTo(migrateToVersion, {
            updateSettings: false,
          })
        : await migrator.prepareMigration({
            updateSettings: false,
          });
      await preparedMigration.execute();

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
      db: kysely,
      provider: "postgresql",
    });

    // Run migrations for all schemas in order
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ormMap = new Map<string, AbstractQuery<any, any>>();

    for (const { schema, namespace, migrateToVersion } of schemas) {
      // Run migrations
      const migrator = adapter.createMigrationEngine(schema, namespace);
      const preparedMigration = migrateToVersion
        ? await migrator.prepareMigrationTo(migrateToVersion, {
            updateSettings: false,
          })
        : await migrator.prepareMigration({
            updateSettings: false,
          });
      await preparedMigration.execute();

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

  // Import drizzle-kit for migrations
  const require = createRequire(import.meta.url);
  const { generateDrizzleJson, generateMigration } =
    require("drizzle-kit/api") as typeof import("drizzle-kit/api");

  // Import generateSchema from the properly exported module
  const { generateSchema } = await import("@fragno-dev/db/adapters/drizzle/generate");

  // Helper to write schema to file and dynamically import it
  const writeAndLoadSchema = async () => {
    const testDir = join(import.meta.dirname, "_generated", "drizzle-test");
    await mkdir(testDir, { recursive: true }).catch(() => {
      // Ignore error if directory already exists
    });

    const schemaFilePath = join(
      testDir,
      `test-schema-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.ts`,
    );

    // Combine all schemas into a single Drizzle schema with namespaced tables
    const schemaConfigs = schemas.map(({ schema, namespace }) => ({
      namespace: namespace ?? "",
      schema,
    }));

    const drizzleSchemaTs = generateSchema(schemaConfigs, "postgresql");
    await writeFile(schemaFilePath, drizzleSchemaTs, "utf-8");

    // Dynamically import the generated schema (with cache busting)
    const schemaModule = await import(`${schemaFilePath}?t=${Date.now()}`);

    const cleanup = async () => {
      await rm(testDir, { recursive: true, force: true });
    };

    return { schemaModule, cleanup };
  };

  // Helper to create a new database instance and run migrations for all schemas
  const createDatabase = async () => {
    // Write schema to file and load it
    const { schemaModule, cleanup } = await writeAndLoadSchema();

    // Create PGlite instance
    const pglite = new PGlite(databasePath);

    // Create Drizzle instance with PGlite
    const db = drizzle(pglite, {
      schema: schemaModule,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    // Generate and run migrations
    const migrationStatements = await generateMigration(
      generateDrizzleJson({}), // Empty schema (starting state)
      generateDrizzleJson(schemaModule), // Target schema
    );

    // Execute migration SQL
    for (const statement of migrationStatements) {
      await db.execute(statement);
    }

    // Create DrizzleAdapter
    const adapter = new DrizzleAdapter({
      db: () => db,
      provider: "postgresql",
    });

    // Create ORM instances for each schema and store in map
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ormMap = new Map<string, AbstractQuery<any, any>>();

    for (const { schema, namespace } of schemas) {
      const orm = adapter.createQueryEngine(schema, namespace);
      ormMap.set(namespace, orm);
    }

    return { drizzle: db, adapter, pglite, cleanup, ormMap };
  };

  // Create initial database
  const {
    drizzle: drizzleDb,
    adapter,
    pglite,
    cleanup: schemaCleanup,
    ormMap,
  } = await createDatabase();

  // Reset database function - truncates all tables (only supported for in-memory databases)
  const resetDatabase = async () => {
    if (databasePath && databasePath !== ":memory:") {
      throw new Error("resetDatabase is only supported for in-memory databases");
    }

    // Truncate all tables by deleting rows
    for (const { schema, namespace } of schemas) {
      const mapper = adapter.createTableNameMapper(namespace);
      for (const tableName of Object.keys(schema.tables)) {
        const physicalTableName = mapper.toPhysical(tableName);
        await drizzleDb.execute(`DELETE FROM "${physicalTableName}"`);
      }
    }
  };

  // Cleanup function - closes connections and deletes generated files and database directory
  const cleanup = async () => {
    await pglite.close();
    await schemaCleanup();

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
  }

  throw new Error(`Unsupported adapter type: ${(adapterConfig as SupportedAdapter).type}`);
}
