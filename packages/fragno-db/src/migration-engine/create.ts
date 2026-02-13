import { type MigrationOperation } from "./shared";
import type { AnySchema } from "../schema/create";
import { generateMigrationFromSchema as defaultGenerateMigrationFromSchema } from "./auto-from-schema";
import {
  buildSystemMigrationOperations,
  resolveSystemMigrationRange,
  type SystemMigration,
  type SystemMigrationContext,
} from "./system-migrations";

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
  /**
   * System migration version currently stored in the database.
   * If omitted, system migrations are skipped unless a system getVersion is provided.
   */
  systemFromVersion?: number;
  /**
   * Override the target system migration version.
   */
  systemToVersion?: number;
  /**
   * @deprecated Use systemFromVersion.
   */
  internalFromVersion?: number;
  /**
   * @deprecated Use systemToVersion.
   */
  internalToVersion?: number;
}

export interface PreparedMigration {
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
  prepareMigration: (options?: MigrateOptions) => Promise<PreparedMigration>;

  /**
   * Migrate to a specific version (only forward migrations allowed)
   * @param toVersion - Target version to migrate to
   * @param options - Migration options including optional fromVersion
   */
  prepareMigrationTo: (
    toVersion: number,
    options?: MigrateOptions & { fromVersion?: number },
  ) => Promise<PreparedMigration>;
}

export interface MigrationEngineOptions {
  /**
   * The target schema to migrate to
   */
  schema: AnySchema;

  executor: (operations: MigrationOperation[]) => Promise<void>;

  generateMigrationFromSchema?: typeof defaultGenerateMigrationFromSchema;

  settings: {
    /**
     * Get current version from database (0 if not initialized)
     */
    getVersion: () => Promise<number>;

    updateSettingsInMigration: (
      fromVersion: number,
      toVersion: number,
    ) => Awaitable<MigrationOperation[]>;
  };

  system?: SystemMigrationConfig;
  /**
   * @deprecated Use system.
   */
  internal?: SystemMigrationConfig;

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

type SystemMigrationConfig = {
  /**
   * System migration list for this dialect.
   */
  migrations: SystemMigration[];

  /**
   * Get current system migration version from database (0 if not initialized)
   */
  getVersion: () => Promise<number>;

  /**
   * Update system migration version in settings table.
   */
  updateSettingsInMigration: (
    fromVersion: number,
    toVersion: number,
  ) => Awaitable<MigrationOperation[]>;

  /**
   * Override namespace for system migration keys.
   * Defaults to schema.name when omitted.
   */
  namespace?: string;
};

export function createMigrator({
  settings,
  generateMigrationFromSchema = defaultGenerateMigrationFromSchema,
  schema: targetSchema,
  executor,
  sql: sqlConfig,
  transformers = [],
  system,
  internal: legacyInternal,
}: MigrationEngineOptions): Migrator {
  const systemConfig = system ?? legacyInternal;

  const instance: Migrator = {
    getVersion() {
      return settings.getVersion();
    },
    async prepareMigration(options = {}) {
      return this.prepareMigrationTo(targetSchema.version, options);
    },
    async prepareMigrationTo(toVersion, options = {}) {
      const {
        updateSettings: updateVersion = true,
        fromVersion: providedFromVersion,
        systemFromVersion,
        systemToVersion,
        internalFromVersion,
        internalToVersion,
      } = options;

      const providedSystemFromVersion = systemFromVersion ?? internalFromVersion;
      const providedSystemToVersion = systemToVersion ?? internalToVersion;

      // Use provided fromVersion if available, otherwise query the database
      const fromVersion = providedFromVersion ?? (await settings.getVersion());

      if (toVersion < 0) {
        throw new Error(`Cannot migrate to negative version: ${toVersion}`);
      }

      if (fromVersion < 0) {
        throw new Error(`Cannot migrate from negative version: ${fromVersion}`);
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

      if (fromVersion > targetSchema.version) {
        throw new Error(
          `Cannot migrate from version ${fromVersion}: schema only has version ${targetSchema.version}`,
        );
      }

      let systemRange:
        | {
            fromVersion: number;
            toVersion: number;
            context: SystemMigrationContext;
          }
        | undefined;

      if (systemConfig) {
        const resolvedSystemFromVersion =
          providedSystemFromVersion ?? (await systemConfig.getVersion());
        const resolvedRange = resolveSystemMigrationRange(
          systemConfig.migrations,
          resolvedSystemFromVersion,
          providedSystemToVersion,
        );

        if (resolvedRange) {
          systemRange = {
            ...resolvedRange,
            context: {
              schema: targetSchema,
              namespace: systemConfig.namespace ?? targetSchema.name,
            },
          };
        }
      }

      if (
        toVersion === fromVersion &&
        (!systemRange || systemRange.fromVersion === systemRange.toVersion)
      ) {
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

      const systemOperations =
        systemConfig && systemRange
          ? buildSystemMigrationOperations(
              systemConfig.migrations,
              systemRange.context,
              systemRange.fromVersion,
              systemRange.toVersion,
            )
          : [];

      let operations = await context.auto();
      if (systemOperations.length > 0) {
        operations = [...operations, ...systemOperations];
      }

      if (updateVersion) {
        if (fromVersion !== toVersion) {
          operations = [
            ...operations,
            ...(await settings.updateSettingsInMigration(fromVersion, toVersion)),
          ];
        }

        if (systemConfig && systemRange && systemRange.fromVersion !== systemRange.toVersion) {
          operations = [
            ...operations,
            ...(await systemConfig.updateSettingsInMigration(
              systemRange.fromVersion,
              systemRange.toVersion,
            )),
          ];
        }
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
