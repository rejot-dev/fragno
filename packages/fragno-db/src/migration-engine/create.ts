import { type MigrationOperation } from "./shared";
import type { Provider } from "../shared/providers";
import type { AnySchema } from "../schema/create";
import { generateMigrationFromSchema as defaultGenerateMigrationFromSchema } from "./auto-from-schema";

type Awaitable<T> = T | Promise<T>;

interface MigrationContext {
  auto: () => Promise<MigrationOperation[]>;
}

export type CustomMigrationFn = (context: MigrationContext) => Awaitable<MigrationOperation[]>;

export interface MigrateOptions {
  /**
   * Update internal settings, it's true by default.
   * We don't recommend to disable it other than testing purposes.
   */
  updateSettings?: boolean;
}

export interface MigrationResult {
  operations: MigrationOperation[];
  getSQL?: () => string;
  execute: () => Promise<void>;
}

export interface Migrator {
  /**
   * Get current version (returns 0 if not initialized)
   */
  getVersion: () => Promise<number>;

  /**
   * Migrate to the latest schema version
   */
  migrate: (options?: MigrateOptions) => Promise<MigrationResult>;

  /**
   * Migrate to a specific version (only forward migrations allowed)
   */
  migrateTo: (version: number, options?: MigrateOptions) => Promise<MigrationResult>;
}

export interface MigrationEngineOptions {
  /**
   * The target schema to migrate to
   */
  schema: AnySchema;

  userConfig: {
    provider: Provider;
  };

  executor: (operations: MigrationOperation[]) => Promise<void>;

  generateMigrationFromSchema?: typeof defaultGenerateMigrationFromSchema;

  settings: {
    /**
     * Get current version from database (0 if not initialized)
     */
    getVersion: () => Promise<number>;

    updateSettingsInMigration: (version: number) => Awaitable<MigrationOperation[]>;
  };

  sql?: {
    toSql: (operations: MigrationOperation[]) => string;
  };

  transformers?: MigrationTransformer[];
}

export interface MigrationTransformer {
  /**
   * Run after auto-generating migration operations
   */
  afterAuto?: (
    operations: MigrationOperation[],
    context: {
      options: MigrateOptions;
      fromVersion: number;
      toVersion: number;
      schema: AnySchema;
    },
  ) => MigrationOperation[];

  /**
   * Run on all migration operations
   */
  afterAll?: (
    operations: MigrationOperation[],
    context: {
      fromVersion: number;
      toVersion: number;
      schema: AnySchema;
    },
  ) => MigrationOperation[];
}

export function createMigrator({
  settings,
  generateMigrationFromSchema = defaultGenerateMigrationFromSchema,
  schema: targetSchema,
  executor,
  sql: sqlConfig,
  transformers = [],
}: MigrationEngineOptions): Migrator {
  const instance: Migrator = {
    getVersion() {
      return settings.getVersion();
    },
    async migrate(options = {}) {
      return this.migrateTo(targetSchema.version, options);
    },
    async migrateTo(toVersion, options = {}) {
      const { updateSettings: updateVersion = true } = options;
      const fromVersion = await settings.getVersion();

      if (toVersion < 0) {
        throw new Error(`Cannot migrate to negative version: ${toVersion}`);
      }

      if (toVersion < fromVersion) {
        throw new Error(
          `Cannot migrate backwards: current version is ${fromVersion}, target is ${toVersion}. Only forward migrations are supported.`,
        );
      }

      if (toVersion > targetSchema.version) {
        throw new Error(
          `Cannot migrate to version ${toVersion}: schema only has version ${targetSchema.version}`,
        );
      }

      if (toVersion === fromVersion) {
        // Already at target version, return empty migration
        return {
          operations: [],
          getSQL: sqlConfig ? () => sqlConfig.toSql([]) : undefined,
          execute: async () => {},
        };
      }

      const context: MigrationContext = {
        async auto() {
          let generated = generateMigrationFromSchema(targetSchema, fromVersion, toVersion);

          for (const transformer of transformers) {
            if (!transformer.afterAuto) {
              continue;
            }

            generated = transformer.afterAuto(generated, {
              fromVersion,
              toVersion,
              schema: targetSchema,
              options,
            });
          }

          return generated;
        },
      };

      let operations = await context.auto();

      if (updateVersion) {
        operations.push(...(await settings.updateSettingsInMigration(toVersion)));
      }

      for (const transformer of transformers) {
        if (!transformer.afterAll) {
          continue;
        }
        operations = transformer.afterAll(operations, {
          fromVersion,
          toVersion,
          schema: targetSchema,
        });
      }

      return {
        operations,
        getSQL: sqlConfig ? () => sqlConfig.toSql(operations) : undefined,
        execute: () => executor(operations),
      };
    },
  };

  return instance;
}
