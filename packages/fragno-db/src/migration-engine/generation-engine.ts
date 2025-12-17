import type { FragnoDatabase } from "../mod";
import type { AnySchema } from "../schema/create";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
} from "../adapters/adapters";
import {
  internalFragmentDef,
  internalSchema,
  SETTINGS_NAMESPACE,
  getSchemaVersionFromDatabase,
} from "../fragments/internal-fragment";
import { instantiate } from "@fragno-dev/core";

export interface GenerationEngineResult {
  schema: string;
  path: string;
  namespace: string;
}

export interface GenerationInternalResult {
  schema: string;
  path: string;
  namespace: string;
  fromVersion: number;
  toVersion: number;
}

export interface ExecuteMigrationResult {
  namespace: string;
  didMigrate: boolean;
  fromVersion: number;
  toVersion: number;
}

export async function generateMigrationsOrSchema<
  // oxlint-disable-next-line no-explicit-any
  const TDatabases extends FragnoDatabase<AnySchema, any>[],
>(
  databases: TDatabases,
  options?: {
    path?: string;
    toVersion?: number;
    fromVersion?: number;
  },
): Promise<GenerationEngineResult[]> {
  if (databases.length === 0) {
    throw new Error("No databases provided for schema generation");
  }

  const firstDb = databases[0];
  const adapter = firstDb.adapter;

  // If adapter has createSchemaGenerator, use it for combined generation (e.g., Drizzle)
  if (adapter.createSchemaGenerator) {
    if (options?.toVersion !== undefined || options?.fromVersion !== undefined) {
      console.warn(
        "⚠️ Warning: --from and --to version options are not supported when generating schemas for multiple fragments and will be ignored.",
      );
    }

    // Collect all schemas, de-duplicating by namespace.
    // The internal fragment (settings schema) is always included first since all database
    // fragments automatically link to it via withDatabase().
    const fragmentsMap = new Map<string, { schema: AnySchema; namespace: string }>();

    // Include internal fragment first with empty namespace (settings table has no prefix)
    fragmentsMap.set("", {
      schema: internalSchema,
      namespace: "",
    });

    // Add user fragments, de-duplicating by namespace
    // Each FragnoDatabase has a unique namespace, so this prevents duplicate schema generation
    for (const db of databases) {
      if (!fragmentsMap.has(db.namespace)) {
        fragmentsMap.set(db.namespace, {
          schema: db.schema,
          namespace: db.namespace,
        });
      }
    }

    const allFragments = Array.from(fragmentsMap.values());
    const generator = adapter.createSchemaGenerator(allFragments, {
      path: options?.path,
    });

    return [
      {
        ...generator.generateSchema(),
        namespace: firstDb.namespace,
      },
    ];
  }

  // Otherwise, use migration engine for individual generation (e.g., Kysely, GenericSQL)
  if (!adapter.prepareMigrations) {
    throw new Error(
      "Adapter does not support migration-based schema generation. Ensure your adapter implements prepareMigrations.",
    );
  }

  if (!(await adapter.isConnectionHealthy())) {
    throw new Error(
      "Database connection is not healthy. Please check your database connection and try again.",
    );
  }

  // Use the internal fragment for settings management
  const internalFragment = instantiate(internalFragmentDef)
    .withConfig({})
    .withOptions({ databaseAdapter: adapter })
    .build();

  const settingsSourceVersion = await getSchemaVersionFromDatabase(
    internalFragment,
    SETTINGS_NAMESPACE,
  );

  const generatedFiles: GenerationInternalResult[] = [];

  // Use empty namespace for settings (SETTINGS_NAMESPACE is for prefixing keys, not the database namespace)
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
      namespace: "", // Empty namespace for settings table
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
        `Adapter for ${db.namespace} does not support schema generation. ` +
          `Ensure your adapter implements either createSchemaGenerator or prepareMigrations.`,
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
        "Try using 'generateMigrationsOrSchema' instead to generate schema files.",
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
    namespace: string;
    fromVersion: number;
    toVersion: number;
    execute: () => Promise<void>;
  }> = [];

  // 1. Prepare settings table migration
  // Use the internal fragment for settings management
  const internalFragment = instantiate(internalFragmentDef)
    .withConfig({})
    .withOptions({ databaseAdapter: adapter })
    .build();

  const settingsSourceVersion = await getSchemaVersionFromDatabase(
    internalFragment,
    SETTINGS_NAMESPACE,
  );

  // Use empty namespace for settings (SETTINGS_NAMESPACE is for prefixing keys, not the database namespace)
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
        namespace: "", // Empty namespace for settings table
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
  const sortedDatabases = [...databases].sort((a, b) => a.namespace.localeCompare(b.namespace));

  for (const fragnoDb of sortedDatabases) {
    const preparedMigrations = adapter.prepareMigrations(fragnoDb.schema, fragnoDb.namespace);
    const currentVersion = await getSchemaVersionFromDatabase(internalFragment, fragnoDb.namespace);
    const targetVersion = fragnoDb.schema.version;

    if (currentVersion < targetVersion) {
      const compiledMigration = preparedMigrations.compile(currentVersion, targetVersion, {
        updateVersionInMigration: true,
      });

      if (compiledMigration.statements.length > 0) {
        migrationsToExecute.push({
          namespace: fragnoDb.namespace,
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
  for (const migration of migrationsToExecute) {
    await migration.execute();
    results.push({
      namespace: migration.namespace,
      didMigrate: true,
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
    });
  }

  // 4. Add skipped migrations (already up-to-date)
  for (const fragnoDb of databases) {
    if (!results.find((r) => r.namespace === fragnoDb.namespace)) {
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
 * Sorts files with settings namespace first, then alphabetically by namespace,
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

  // Sort files: settings namespace first (empty string), then alphabetically by namespace
  const sortedFiles = [...files].sort((a, b) => {
    // Settings table has empty namespace - sort it first
    if (a.namespace === "") {
      return -1;
    }
    if (b.namespace === "") {
      return 1;
    }
    return a.namespace.localeCompare(b.namespace);
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

    // For settings table (empty namespace), use "fragno_db_settings" in the filename
    // For other tables, use their namespace
    const safeName =
      file.namespace === "" ? "fragno_db_settings" : file.namespace.replace(/[^a-z0-9-]/gi, "_");
    const newPath = `${date}_${orderNum}_f${fromPadded}_t${toPadded}_${safeName}.sql`;

    return {
      schema: file.schema,
      path: newPath,
      namespace: file.namespace,
    };
  });
}
