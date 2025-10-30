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

// Conditional return types based on adapter
export type TestContext<T extends SupportedAdapter> = T extends
  | KyselySqliteAdapter
  | KyselyPgliteAdapter
  ? {
      readonly db: AbstractQuery<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      readonly kysely: Kysely<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      readonly adapter: DatabaseAdapter<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      resetDatabase: () => Promise<void>;
      cleanup: () => Promise<void>;
    }
  : T extends DrizzlePgliteAdapter
    ? {
        readonly db: AbstractQuery<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        readonly drizzle: ReturnType<typeof drizzle<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
        readonly adapter: DatabaseAdapter<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        resetDatabase: () => Promise<void>;
        cleanup: () => Promise<void>;
      }
    : never;

// Factory function return type
interface AdapterFactoryResult<T extends SupportedAdapter> {
  testContext: TestContext<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: DatabaseAdapter<any>;
}

/**
 * Create Kysely + SQLite adapter using SQLocalKysely (always in-memory)
 */
export async function createKyselySqliteAdapter(
  _config: KyselySqliteAdapter,
  schema: AnySchema,
  namespace: string,
  migrateToVersion?: number,
): Promise<AdapterFactoryResult<KyselySqliteAdapter>> {
  // Helper to create a new database instance and run migrations
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

    // Create ORM instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orm = adapter.createQueryEngine(schema, namespace) as AbstractQuery<any>;

    return { kysely, adapter, orm };
  };

  // Create initial database
  let { kysely, adapter, orm } = await createDatabase();

  // Reset database function - creates a fresh in-memory database and re-runs migrations
  const resetDatabase = async () => {
    // Destroy the old Kysely instance
    await kysely.destroy();

    // Create a new database instance
    const newDb = await createDatabase();
    kysely = newDb.kysely;
    adapter = newDb.adapter;
    orm = newDb.orm;
  };

  // Cleanup function - closes connections (no files to delete for in-memory)
  const cleanup = async () => {
    await kysely.destroy();
  };

  return {
    testContext: {
      get db() {
        return orm;
      },
      get kysely() {
        return kysely;
      },
      get adapter() {
        return adapter;
      },
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
 */
export async function createKyselyPgliteAdapter(
  config: KyselyPgliteAdapter,
  schema: AnySchema,
  namespace: string,
  migrateToVersion?: number,
): Promise<AdapterFactoryResult<KyselyPgliteAdapter>> {
  const databasePath = config.databasePath;

  // Helper to create a new database instance and run migrations
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

    // Create ORM instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orm = adapter.createQueryEngine(schema, namespace) as AbstractQuery<any>;

    return { kysely, adapter, kyselyPglite, orm };
  };

  // Create initial database
  let { kysely, adapter, kyselyPglite, orm } = await createDatabase();

  // Reset database function - creates a fresh database and re-runs migrations
  const resetDatabase = async () => {
    // Close the old instances
    await kysely.destroy();

    try {
      await kyselyPglite.client.close();
    } catch {
      // Ignore if already closed
    }

    // Create a new database instance
    const newDb = await createDatabase();
    kysely = newDb.kysely;
    adapter = newDb.adapter;
    kyselyPglite = newDb.kyselyPglite;
    orm = newDb.orm;
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

  return {
    testContext: {
      get db() {
        return orm;
      },
      get kysely() {
        return kysely;
      },
      get adapter() {
        return adapter;
      },
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
 */
export async function createDrizzlePgliteAdapter(
  config: DrizzlePgliteAdapter,
  schema: AnySchema,
  namespace: string,
  _migrateToVersion?: number,
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

    // Generate and write the Drizzle schema to file
    const drizzleSchemaTs = generateSchema([{ namespace: namespace ?? "", schema }], "postgresql");
    await writeFile(schemaFilePath, drizzleSchemaTs, "utf-8");

    // Dynamically import the generated schema (with cache busting)
    const schemaModule = await import(`${schemaFilePath}?t=${Date.now()}`);

    const cleanup = async () => {
      await rm(testDir, { recursive: true, force: true });
    };

    return { schemaModule, cleanup };
  };

  // Helper to create a new database instance and run migrations
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

    // Create ORM instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orm = adapter.createQueryEngine(schema, namespace) as AbstractQuery<any>;

    return { drizzle: db, adapter, pglite, cleanup, orm };
  };

  // Create initial database
  let { drizzle: drizzleDb, adapter, pglite, cleanup: schemaCleanup, orm } = await createDatabase();

  // Reset database function - creates a fresh database and re-runs migrations
  const resetDatabase = async () => {
    // Close the old instances and cleanup
    await pglite.close();
    await schemaCleanup();

    // Create a new database instance
    const newDb = await createDatabase();
    drizzleDb = newDb.drizzle;
    adapter = newDb.adapter;
    pglite = newDb.pglite;
    schemaCleanup = newDb.cleanup;
    orm = newDb.orm;
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

  return {
    testContext: {
      get db() {
        return orm;
      },
      get drizzle() {
        return drizzleDb;
      },
      get adapter() {
        return adapter;
      },
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
 */
export async function createAdapter<T extends SupportedAdapter>(
  adapterConfig: T,
  schema: AnySchema,
  namespace: string,
  migrateToVersion?: number,
): Promise<AdapterFactoryResult<T>> {
  if (adapterConfig.type === "kysely-sqlite") {
    return createKyselySqliteAdapter(adapterConfig, schema, namespace, migrateToVersion) as Promise<
      AdapterFactoryResult<T>
    >;
  } else if (adapterConfig.type === "kysely-pglite") {
    return createKyselyPgliteAdapter(adapterConfig, schema, namespace, migrateToVersion) as Promise<
      AdapterFactoryResult<T>
    >;
  } else if (adapterConfig.type === "drizzle-pglite") {
    return createDrizzlePgliteAdapter(
      adapterConfig,
      schema,
      namespace,
      migrateToVersion,
    ) as Promise<AdapterFactoryResult<T>>;
  }

  throw new Error(`Unsupported adapter type: ${(adapterConfig as SupportedAdapter).type}`);
}
