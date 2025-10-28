import type { FragnoDatabase } from "../mod";
import type { AnySchema } from "../schema/create";
import type { PreparedMigration } from "./create";
import {
  settingsSchema,
  SETTINGS_NAMESPACE,
  createSettingsManager,
} from "../shared/settings-schema";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
} from "../adapters/adapters";

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
  preparedMigration?: PreparedMigration;
}

export interface ExecuteMigrationResult {
  namespace: string;
  didMigrate: boolean;
  fromVersion: number;
  toVersion: number;
}

export async function generateMigrationsOrSchema<
  const TDatabases extends FragnoDatabase<AnySchema>[],
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

    const fragments = databases.map((db) => ({
      schema: db.schema,
      namespace: db.namespace,
    }));

    const generator = adapter.createSchemaGenerator(fragments, {
      path: options?.path,
    });

    return [
      {
        ...generator.generateSchema(),
        namespace: firstDb.namespace,
      },
    ];
  }

  // Otherwise, use migration engine for individual generation (e.g., Kysely)
  if (!adapter.createMigrationEngine) {
    throw new Error(
      "Adapter does not support migration-based schema generation. Ensure your adapter implements createMigrationEngine.",
    );
  }

  if (!(await adapter.isConnectionHealthy())) {
    throw new Error(
      "Database connection is not healthy. Please check your database connection and try again.",
    );
  }

  const settingsQueryEngine = adapter.createQueryEngine(settingsSchema, "");
  const settingsManager = createSettingsManager(settingsQueryEngine, SETTINGS_NAMESPACE);

  let settingsSourceVersion: number;
  try {
    const result = await settingsManager.get("version");

    if (!result) {
      settingsSourceVersion = 0;
    } else {
      settingsSourceVersion = parseInt(result.value);
    }
  } catch {
    // We don't really have a way to verify this error happens because the key doesn't exist in the database
    settingsSourceVersion = 0;
  }

  const generatedFiles: GenerationInternalResult[] = [];

  const settingsMigrator = adapter.createMigrationEngine(settingsSchema, SETTINGS_NAMESPACE);
  const settingsTargetVersion = settingsSchema.version;

  // Generate settings table migration
  const settingsMigration = await settingsMigrator.prepareMigrationTo(settingsTargetVersion, {
    fromVersion: settingsSourceVersion,
  });

  if (!settingsMigration.getSQL) {
    throw new Error(
      "Migration engine does not support SQL generation. Ensure your adapter's migration engine provides getSQL().",
    );
  }

  const settingsSql = settingsMigration.getSQL();

  if (settingsSql.trim()) {
    generatedFiles.push({
      schema: settingsSql,
      path: "settings-migration.sql", // Placeholder, will be renamed in post-processing
      namespace: SETTINGS_NAMESPACE,
      fromVersion: settingsSourceVersion,
      toVersion: settingsTargetVersion,
      preparedMigration: settingsMigration,
    });
  }

  // Generate migration for each fragment
  for (const db of databases) {
    const dbAdapter = db.adapter;

    // Use migration engine
    if (!dbAdapter.createMigrationEngine) {
      throw new Error(
        `Adapter for ${db.namespace} does not support schema generation. ` +
          `Ensure your adapter implements either createSchemaGenerator or createMigrationEngine.`,
      );
    }

    const migrator = dbAdapter.createMigrationEngine(db.schema, db.namespace);
    const targetVersion = options?.toVersion ?? db.schema.version;
    const sourceVersion = options?.fromVersion ?? 0;

    // Generate migration from source to target version
    const preparedMigration = await migrator.prepareMigrationTo(targetVersion, {
      fromVersion: sourceVersion,
    });

    if (!preparedMigration.getSQL) {
      throw new Error(
        "Migration engine does not support SQL generation. Ensure your adapter's migration engine provides getSQL().",
      );
    }

    const sql = preparedMigration.getSQL();

    // If no migrations needed, skip this fragment
    if (sql.trim()) {
      generatedFiles.push({
        schema: sql,
        path: "schema.sql", // Placeholder, will be renamed in post-processing
        namespace: db.namespace,
        fromVersion: sourceVersion,
        toVersion: targetVersion,
        preparedMigration: preparedMigration,
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
  if (!adapter.createMigrationEngine) {
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
    preparedMigration: PreparedMigration;
  }> = [];

  // 1. Prepare settings table migration
  const settingsQueryEngine = adapter.createQueryEngine(settingsSchema, "");
  const settingsManager = createSettingsManager(settingsQueryEngine, SETTINGS_NAMESPACE);

  let settingsSourceVersion: number;
  try {
    const result = await settingsManager.get("version");
    settingsSourceVersion = result ? parseInt(result.value) : 0;
  } catch {
    settingsSourceVersion = 0;
  }

  const settingsMigrator = adapter.createMigrationEngine(settingsSchema, SETTINGS_NAMESPACE);
  const settingsTargetVersion = settingsSchema.version;

  if (settingsSourceVersion < settingsTargetVersion) {
    const settingsMigration = await settingsMigrator.prepareMigrationTo(settingsTargetVersion, {
      fromVersion: settingsSourceVersion,
      updateSettings: true,
    });

    if (settingsMigration.operations.length > 0) {
      migrationsToExecute.push({
        namespace: SETTINGS_NAMESPACE,
        fromVersion: settingsSourceVersion,
        toVersion: settingsTargetVersion,
        preparedMigration: settingsMigration,
      });
    }
  }

  // 2. Prepare fragment migrations (sorted alphabetically)
  const sortedDatabases = [...databases].sort((a, b) => a.namespace.localeCompare(b.namespace));

  for (const fragnoDb of sortedDatabases) {
    const migrator = adapter.createMigrationEngine(fragnoDb.schema, fragnoDb.namespace);
    const currentVersion = await migrator.getVersion();
    const targetVersion = fragnoDb.schema.version;

    if (currentVersion < targetVersion) {
      const preparedMigration = await migrator.prepareMigrationTo(targetVersion, {
        updateSettings: true,
      });

      if (preparedMigration.operations.length > 0) {
        migrationsToExecute.push({
          namespace: fragnoDb.namespace,
          fromVersion: currentVersion,
          toVersion: targetVersion,
          preparedMigration: preparedMigration,
        });
      }
    }
  }

  // 3. Execute all migrations in order
  for (const migration of migrationsToExecute) {
    await migration.preparedMigration.execute();
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

  // Sort files: settings namespace first, then alphabetically by namespace
  const sortedFiles = [...files].sort((a, b) => {
    if (a.namespace === SETTINGS_NAMESPACE) {
      return -1;
    }
    if (b.namespace === SETTINGS_NAMESPACE) {
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
    const safeName = file.namespace.replace(/[^a-z0-9-]/gi, "_");
    const newPath = `${date}_${orderNum}_f${fromPadded}_t${toPadded}_${safeName}.sql`;

    return {
      schema: file.schema,
      path: newPath,
      namespace: file.namespace,
    };
  });
}
