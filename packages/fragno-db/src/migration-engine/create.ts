import { type MigrationOperation } from "./shared";
import type { AnySchema } from "../schema/create";
import { generateMigrationFromSchema as defaultGenerateMigrationFromSchema } from "./auto-from-schema";
import {
  buildInternalMigrationOperations,
  resolveInternalMigrationRange,
  type InternalMigration,
  type InternalMigrationContext,
} from "./internal-migrations";

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
   * Internal migration version currently stored in the database.
   * If omitted, internal migrations are skipped unless an internal getVersion is provided.
   */
  internalFromVersion?: number;
  /**
   * Override the target internal migration version.
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

  internal?: {
    /**
     * Internal migration list for this dialect.
     */
    migrations: InternalMigration[];

    /**
     * Get current internal migration version from database (0 if not initialized)
     */
    getVersion: () => Promise<number>;

    /**
     * Update internal migration version in settings table.
     */
    updateSettingsInMigration: (
      fromVersion: number,
      toVersion: number,
    ) => Awaitable<MigrationOperation[]>;

    /**
     * Override namespace for internal migration keys.
     * Defaults to schema.name when omitted.
     */
    namespace?: string;
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
  internal,
}: MigrationEngineOptions): Migrator {
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
        internalFromVersion: providedInternalFromVersion,
        internalToVersion: providedInternalToVersion,
      } = options;

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

      let internalRange:
        | {
            fromVersion: number;
            toVersion: number;
            context: InternalMigrationContext;
          }
        | undefined;

      if (internal) {
        const internalFromVersion = providedInternalFromVersion ?? (await internal.getVersion());
        const resolvedRange = resolveInternalMigrationRange(
          internal.migrations,
          internalFromVersion,
          providedInternalToVersion,
        );

        if (resolvedRange) {
          internalRange = {
            ...resolvedRange,
            context: {
              schema: targetSchema,
              namespace: internal.namespace ?? targetSchema.name,
            },
          };
        }
      }

      if (
        toVersion === fromVersion &&
        (!internalRange || internalRange.fromVersion === internalRange.toVersion)
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

      const internalOperations =
        internal && internalRange
          ? buildInternalMigrationOperations(
              internal.migrations,
              internalRange.context,
              internalRange.fromVersion,
              internalRange.toVersion,
            )
          : [];

      let operations = await context.auto();
      if (internalOperations.length > 0) {
        operations = [...operations, ...internalOperations];
      }

      if (updateVersion) {
        if (fromVersion !== toVersion) {
          operations = [
            ...operations,
            ...(await settings.updateSettingsInMigration(fromVersion, toVersion)),
          ];
        }

        if (internal && internalRange && internalRange.fromVersion !== internalRange.toVersion) {
          operations = [
            ...operations,
            ...(await internal.updateSettingsInMigration(
              internalRange.fromVersion,
              internalRange.toVersion,
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
