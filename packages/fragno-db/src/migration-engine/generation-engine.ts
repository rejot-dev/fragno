import type { FragnoDatabase } from "../mod";
import type { AnySchema } from "../schema/create";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
} from "../adapters/adapters";
import { generateDrizzleSchema } from "../schema-output/drizzle";
import { generatePrismaSchema } from "../schema-output/prisma";
import {
  internalFragmentDef,
  internalSchema,
  SETTINGS_TABLE_NAME,
  getSchemaVersionFromDatabase,
} from "../fragments/internal-fragment";
import { getRegistryForAdapterSync } from "../internal/adapter-registry";
import { instantiate } from "@fragno-dev/core";
import { supportedDatabases, type SupportedDatabase } from "../adapters/generic-sql/driver-config";

export interface GenerationEngineResult {
  schema: string;
  path: string;
  namespace: string | null;
}

export type SchemaOutputFormat = "sql" | "drizzle" | "prisma";

export interface GenerateSchemaOptions {
  format?: SchemaOutputFormat;
  path?: string;
  toVersion?: number;
  fromVersion?: number;
}

export interface GenerationInternalResult {
  schema: string;
  path: string;
  namespace: string | null;
  namespaceKey: string;
  schemaName: string;
  isSettings: boolean;
  fromVersion: number;
  toVersion: number;
}

export interface ExecuteMigrationResult {
  namespace: string | null;
  didMigrate: boolean;
  fromVersion: number;
  toVersion: number;
}

const DEFAULT_DRIZZLE_PATH = "fragno-schema.ts";
const DEFAULT_PRISMA_PATH = "fragno.prisma";

const isSupportedDatabase = (value: string): value is SupportedDatabase =>
  supportedDatabases.includes(value as SupportedDatabase);

export async function generateSchemaArtifacts<
  // oxlint-disable-next-line no-explicit-any
  const TDatabases extends FragnoDatabase<AnySchema, any>[],
>(databases: TDatabases, options?: GenerateSchemaOptions): Promise<GenerationEngineResult[]> {
  if (databases.length === 0) {
    throw new Error("No databases provided for schema generation");
  }

  const firstDb = databases[0];
  const adapter = firstDb.adapter;
  const format = options?.format ?? "sql";

  if (format !== "sql") {
    if (options?.toVersion !== undefined || options?.fromVersion !== undefined) {
      throw new Error("--from and --to are only supported when generating SQL migrations.");
    }

    const databaseType = adapter.adapterMetadata?.databaseType;
    if (!databaseType || !isSupportedDatabase(databaseType)) {
      throw new Error(
        "Adapter does not expose databaseType metadata required for schema output generation.",
      );
    }

    // Collect all schemas, de-duplicating by namespace.
    // The internal fragment (settings schema) is always included first since all database
    // fragments automatically link to it via withDatabase().
    const fragmentsMap = new Map<string, { schema: AnySchema; namespace: string | null }>();

    // Include internal fragment first with empty namespace (settings table has no prefix)
    fragmentsMap.set(internalSchema.name, {
      schema: internalSchema,
      namespace: null,
    });

    // Add user fragments, de-duplicating by namespace
    // Each FragnoDatabase has a unique namespace, so this prevents duplicate schema generation
    for (const db of databases) {
      const namespaceKey = db.namespace ?? db.schema.name;
      if (!fragmentsMap.has(namespaceKey)) {
        fragmentsMap.set(namespaceKey, {
          schema: db.schema,
          namespace: db.namespace,
        });
      }
    }

    const allFragments = Array.from(fragmentsMap.values());
    const defaultPath = format === "drizzle" ? DEFAULT_DRIZZLE_PATH : DEFAULT_PRISMA_PATH;
    const schema =
      format === "drizzle"
        ? generateDrizzleSchema(allFragments, databaseType, {
            namingStrategy: adapter.namingStrategy,
          })
        : generatePrismaSchema(allFragments, databaseType, {
            sqliteStorageMode: adapter.adapterMetadata?.sqliteStorageMode,
            namingStrategy: adapter.namingStrategy,
          });

    return [
      {
        schema,
        path: options?.path ?? defaultPath,
        namespace: firstDb.namespace,
      },
    ];
  }

  // Otherwise, use migration engine for SQL migration generation.
  if (!adapter.prepareMigrations) {
    throw new Error(
      "Adapter does not support migration generation. Ensure your adapter implements prepareMigrations.",
    );
  }

  if (!(await adapter.isConnectionHealthy())) {
    throw new Error(
      "Database connection is not healthy. Please check your database connection and try again.",
    );
  }

  // Use the internal fragment for settings management
  const internalFragment = instantiate(internalFragmentDef)
    .withConfig({ registry: getRegistryForAdapterSync(adapter) })
    .withOptions({ databaseAdapter: adapter, databaseNamespace: null })
    .build();

  const settingsSourceVersion = await getSchemaVersionFromDatabase(internalFragment, "");

  const generatedFiles: GenerationInternalResult[] = [];

  // Internal fragment uses empty-string namespace: no table suffix, version key is ".schema_version"
  const settingsPreparedMigrations = adapter.prepareMigrations(internalSchema, "");
  const settingsTargetVersion = internalSchema.version;

  // Generate settings table migration
  const settingsSql = settingsPreparedMigrations.getSQL(
    settingsSourceVersion,
    settingsTargetVersion,
  );

  if (settingsSql.trim()) {
    generatedFiles.push({
      schema: settingsSql,
      path: "settings-migration.sql", // Placeholder, will be renamed in post-processing
      namespace: null,
      namespaceKey: SETTINGS_TABLE_NAME,
      schemaName: internalSchema.name,
      isSettings: true,
      fromVersion: settingsSourceVersion,
      toVersion: settingsTargetVersion,
    });
  }

  // Generate migration for each fragment
  for (const db of databases) {
    const dbAdapter = db.adapter;

    // Use migration engine
    if (!dbAdapter.prepareMigrations) {
      throw new Error(
        `Adapter for ${db.namespace ?? db.schema.name} does not support migration generation. ` +
          `Ensure your adapter implements prepareMigrations.`,
      );
    }

    const preparedMigrations = dbAdapter.prepareMigrations(db.schema, db.namespace);
    const targetVersion = options?.toVersion ?? db.schema.version;
    const sourceVersion = options?.fromVersion ?? 0;

    // Generate migration from source to target version
    const sql = preparedMigrations.getSQL(sourceVersion, targetVersion);

    // If no migrations needed, skip this fragment
    if (sql.trim()) {
      generatedFiles.push({
        schema: sql,
        path: "schema.sql", // Placeholder, will be renamed in post-processing
        namespace: db.namespace,
        namespaceKey: db.namespace ?? db.schema.name,
        schemaName: db.schema.name,
        isSettings: false,
        fromVersion: sourceVersion,
        toVersion: targetVersion,
      });
    }
  }

  // Post-process filenames with ordering
  return postProcessMigrationFilenames(generatedFiles);
}

/**
 * Execute migrations for all fragments in the correct order.
 * Migrates settings table first, then fragments alphabetically.
 *
 * @param databases - Array of FragnoDatabase instances to migrate
 * @returns Array of execution results for each migration
 */
export async function executeMigrations<const TDatabases extends FragnoDatabase<AnySchema>[]>(
  databases: TDatabases,
): Promise<ExecuteMigrationResult[]> {
  if (databases.length === 0) {
    throw new Error("No databases provided for migration");
  }

  const firstDb = databases[0];
  const adapter = firstDb.adapter;

  // Validate adapter supports migrations
  if (!adapter.prepareMigrations) {
    throw new Error(
      "Adapter does not support running migrations. The adapter only supports schema generation.\n" +
        "Try using 'generateSchemaArtifacts' instead to generate schema files.",
    );
  }

  // Validate all use same adapter name and version
  const firstAdapterName = adapter[fragnoDatabaseAdapterNameFakeSymbol];
  const firstAdapterVersion = adapter[fragnoDatabaseAdapterVersionFakeSymbol];

  for (const db of databases) {
    const dbAdapterName = db.adapter[fragnoDatabaseAdapterNameFakeSymbol];
    const dbAdapterVersion = db.adapter[fragnoDatabaseAdapterVersionFakeSymbol];

    if (dbAdapterName !== firstAdapterName || dbAdapterVersion !== firstAdapterVersion) {
      throw new Error(
        `All fragments must use the same database adapter. ` +
          `Found: ${firstAdapterName}@${firstAdapterVersion} and ${dbAdapterName}@${dbAdapterVersion}`,
      );
    }
  }

  if (!(await adapter.isConnectionHealthy())) {
    throw new Error(
      "Database connection is not healthy. Please check your database connection and try again.",
    );
  }

  const results: ExecuteMigrationResult[] = [];
  const migrationsToExecute: Array<{
    namespace: string | null;
    namespaceKey: string;
    fromVersion: number;
    toVersion: number;
    execute: () => Promise<void>;
  }> = [];

  // 1. Prepare settings table migration
  // Use the internal fragment for settings management
  const internalFragment = instantiate(internalFragmentDef)
    .withConfig({ registry: getRegistryForAdapterSync(adapter) })
    .withOptions({ databaseAdapter: adapter, databaseNamespace: null })
    .build();

  const settingsSourceVersion = await getSchemaVersionFromDatabase(internalFragment, "");

  // Internal fragment uses empty-string namespace: no table suffix, version key is ".schema_version"
  const settingsPreparedMigrations = adapter.prepareMigrations(internalSchema, "");
  const settingsTargetVersion = internalSchema.version;

  if (settingsSourceVersion < settingsTargetVersion) {
    const compiledMigration = settingsPreparedMigrations.compile(
      settingsSourceVersion,
      settingsTargetVersion,
      { updateVersionInMigration: true },
    );

    if (compiledMigration.statements.length > 0) {
      migrationsToExecute.push({
        namespace: null,
        namespaceKey: SETTINGS_TABLE_NAME,
        fromVersion: settingsSourceVersion,
        toVersion: settingsTargetVersion,
        execute: () =>
          settingsPreparedMigrations.execute(settingsSourceVersion, settingsTargetVersion, {
            updateVersionInMigration: true,
          }),
      });
    }
  }

  // 2. Prepare fragment migrations (sorted alphabetically)
  const getNamespaceKey = (db: FragnoDatabase<AnySchema>) => db.namespace ?? db.schema.name;
  const sortedDatabases = [...databases].sort((a, b) =>
    getNamespaceKey(a).localeCompare(getNamespaceKey(b)),
  );

  for (const fragnoDb of sortedDatabases) {
    const namespaceKey = getNamespaceKey(fragnoDb);
    const preparedMigrations = adapter.prepareMigrations(fragnoDb.schema, fragnoDb.namespace);
    const currentVersion = await getSchemaVersionFromDatabase(internalFragment, namespaceKey);
    const targetVersion = fragnoDb.schema.version;

    if (currentVersion < targetVersion) {
      const compiledMigration = preparedMigrations.compile(currentVersion, targetVersion, {
        updateVersionInMigration: true,
      });

      if (compiledMigration.statements.length > 0) {
        migrationsToExecute.push({
          namespace: fragnoDb.namespace,
          namespaceKey,
          fromVersion: currentVersion,
          toVersion: targetVersion,
          execute: () =>
            preparedMigrations.execute(currentVersion, targetVersion, {
              updateVersionInMigration: true,
            }),
        });
      }
    }
  }

  // 3. Execute all migrations in order
  const executedNamespaceKeys = new Set<string>();
  for (const migration of migrationsToExecute) {
    await migration.execute();
    results.push({
      namespace: migration.namespace,
      didMigrate: true,
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
    });
    executedNamespaceKeys.add(migration.namespaceKey);
  }

  // 4. Add skipped migrations (already up-to-date)
  for (const fragnoDb of databases) {
    const namespaceKey = getNamespaceKey(fragnoDb);
    if (!executedNamespaceKeys.has(namespaceKey)) {
      results.push({
        namespace: fragnoDb.namespace,
        didMigrate: false,
        fromVersion: fragnoDb.schema.version,
        toVersion: fragnoDb.schema.version,
      });
    }
  }

  return results;
}

/**
 * Post-processes migration files to add ordering and standardize naming.
 *
 * Sorts files with settings namespace first, then alphabetically by namespace key,
 * and assigns ordering numbers. Transforms filenames to format:
 * `<date>_<n>_f<from>_t<to>_<namespace>.sql`
 *
 * @param files - Array of generated migration files with version information
 * @returns Array of files with standardized paths and ordering
 */
export function postProcessMigrationFilenames(
  files: GenerationInternalResult[],
): GenerationEngineResult[] {
  if (files.length === 0) {
    return [];
  }

  // Sort files: settings first, then alphabetically by namespace key
  const sortedFiles = [...files].sort((a, b) => {
    if (a.isSettings) {
      return -1;
    }
    if (b.isSettings) {
      return 1;
    }
    return a.namespaceKey.localeCompare(b.namespaceKey);
  });

  // Generate date prefix for filenames
  const date = new Date().toISOString().split("T")[0].replace(/-/g, "");

  // Rename files with ordering
  return sortedFiles.map((file, index) => {
    const fromVersion = file.fromVersion ?? 0;
    const toVersion = file.toVersion ?? 0;

    // Create new filename with ordering
    const orderNum = (index + 1).toString().padStart(3, "0");
    const fromPadded = fromVersion.toString().padStart(3, "0");
    const toPadded = toVersion.toString().padStart(3, "0");

    const safeName = file.namespaceKey.replace(/[^a-z0-9-]/gi, "_");
    const newPath = `${date}_${orderNum}_f${fromPadded}_t${toPadded}_${safeName}.sql`;

    return {
      schema: file.schema,
      path: newPath,
      namespace: file.namespace,
    };
  });
}
