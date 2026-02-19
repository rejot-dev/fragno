import type { DatabaseAdapter } from "./adapters/adapters";
import type { AnySchema } from "./schema/create";
import type { CursorResult } from "./query/cursor";
import { Cursor } from "./query/cursor";
import { dbNow, type DbNow } from "./query/db-now";
import type { FragnoInstantiatedFragment } from "@fragno-dev/core";
import type {
  DatabaseHandlerContext,
  DatabaseRequestStorage,
  DatabaseServiceContext,
  FragnoPublicConfigWithDatabase,
  ImplicitDatabaseDependencies,
} from "./db-fragment-definition-builder";
import type { HooksMap } from "./hooks/hooks";
import {
  getSchemaVersionFromDatabase,
  getSystemMigrationVersionFromDatabase,
} from "./fragments/internal-fragment";
import { getInternalFragment } from "./internal/adapter-registry";

export type { DatabaseAdapter, CursorResult };
export { Cursor };
export { dbNow };
export type { DbNow };
export type { ShardingStrategy } from "./sharding";
export { InMemoryAdapter, type InMemoryAdapterOptions } from "./adapters/in-memory";
export { internalSchema } from "./fragments/internal-fragment";
export { getInternalFragment } from "./internal/adapter-registry";

export const fragnoDatabaseFakeSymbol = "$fragno-database" as const;
export const fragnoDatabaseLibraryVersion = "0.1" as const;

export interface CreateFragnoDatabaseDefinitionOptions<T extends AnySchema> {
  namespace: string | null;
  schema: T;
}

export function isFragnoDatabase(value: unknown): value is FragnoDatabase<AnySchema> {
  if (value instanceof FragnoDatabase) {
    return true;
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    fragnoDatabaseFakeSymbol in value &&
    value[fragnoDatabaseFakeSymbol] === fragnoDatabaseFakeSymbol
  );
}

/**
 * A Fragno database instance with a bound adapter.
 * Created from a FragnoDatabaseDefinition by calling .create(adapter).
 */
export class FragnoDatabase<const T extends AnySchema, TUOWConfig = void> {
  #namespace: string | null;
  #schema: T;
  #adapter: DatabaseAdapter<TUOWConfig>;

  constructor(options: {
    namespace: string | null;
    schema: T;
    adapter: DatabaseAdapter<TUOWConfig>;
  }) {
    this.#namespace = options.namespace;
    this.#schema = options.schema;
    this.#adapter = options.adapter;
  }

  get [fragnoDatabaseFakeSymbol](): typeof fragnoDatabaseFakeSymbol {
    return fragnoDatabaseFakeSymbol;
  }

  get namespace() {
    return this.#namespace;
  }

  get schema() {
    return this.#schema;
  }

  get adapter(): DatabaseAdapter<TUOWConfig> {
    return this.#adapter;
  }
}

export {
  DatabaseFragmentDefinitionBuilder,
  type FragnoPublicConfigWithDatabase,
  type DatabaseFragmentContext,
  type DatabaseServiceContext,
  type DatabaseHandlerContext as DatabaseRequestContext,
  type ImplicitDatabaseDependencies,
} from "./db-fragment-definition-builder";

export { withDatabase } from "./with-database";

export { decodeCursor, type CursorData } from "./query/cursor";

export {
  createUnitOfWork,
  UnitOfWork,
  TypedUnitOfWork,
  type IUnitOfWork,
  type IUnitOfWorkRestricted,
  type UOWCompiler,
  type UOWExecutor,
  type UOWDecoder,
} from "./query/unit-of-work/unit-of-work";

export {
  type RetryPolicy,
  NoRetryPolicy,
  ExponentialBackoffRetryPolicy,
  LinearBackoffRetryPolicy,
} from "./query/unit-of-work/retry-policy";

export {
  ConcurrencyConflictError,
  // Builder pattern exports
  ServiceTxBuilder,
  HandlerTxBuilder,
  createServiceTxBuilder,
  createHandlerTxBuilder,
  type TxResult,
  // Builder context types
  type HandlerTxContext,
  type ServiceBuilderMutateContext,
  type HandlerBuilderMutateContext,
  type BuilderTransformContextWithMutate,
  type BuilderTransformContextWithoutMutate,
  type ExtractServiceRetrieveResults,
  type ExtractServiceFinalResults,
} from "./query/unit-of-work/execute-unit-of-work";

export type { BoundServices } from "@fragno-dev/core";

export { internalFragmentDef } from "./fragments/internal-fragment";
export type { InternalFragmentInstance } from "./fragments/internal-fragment";
export type {
  OutboxConfig,
  OutboxEntry,
  OutboxPayload,
  OutboxMutation,
  OutboxRefMap,
} from "./outbox/outbox";

export type {
  HookContext,
  HooksMap,
  HookFn,
  HookPayload,
  TriggerHookOptions,
  DurableHooksProcessingOptions,
  StuckHookProcessingInfo,
  StuckHookProcessingEvent,
  StuckHookProcessingTimeoutMinutes,
} from "./hooks/hooks";
export {
  createDurableHooksProcessor,
  type DurableHooksProcessor,
} from "./hooks/durable-hooks-processor";
export { defineSyncCommands } from "./sync/commands";
export type {
  SubmitAppliedResponse,
  SubmitConflictReason,
  SubmitConflictResponse,
  SubmitRequest,
  SubmitResponse,
  SyncCommandDefinition,
  SyncCommandHandler,
  SyncCommandRegistry,
  SyncCommandTxFactory,
} from "./sync/types";

export type AnyFragnoInstantiatedDatabaseFragment<TSchema extends AnySchema = AnySchema> =
  FragnoInstantiatedFragment<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    ImplicitDatabaseDependencies<TSchema>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    DatabaseServiceContext<HooksMap>,
    DatabaseHandlerContext,
    DatabaseRequestStorage,
    FragnoPublicConfigWithDatabase
  >;

/**
 * Helper function to run migrations for a database fragment.
 * Extracts the database adapter, schema, and namespace from the fragment and runs migrations.
 * This function:
 * 1. Ensures the internal settings fragment is migrated first
 * 2. Retrieves the current database version from the internal fragment
 * 3. Runs migration from current version to target version
 *
 * @param fragment - The instantiated fragment to run migrations for
 * @throws Error if the fragment doesn't have database support or the adapter doesn't support migrations
 *
 * @example
 * ```typescript
 * const fragment = instantiate(myFragmentDef)
 *   .withConfig({})
 *   .withRoutes([])
 *   .withOptions({ databaseAdapter: myAdapter })
 *   .build();
 *
 * await migrate(fragment);
 * ```
 */
export async function migrate<TSchema extends AnySchema>(
  fragment: AnyFragnoInstantiatedDatabaseFragment<TSchema>,
): Promise<void> {
  const { deps } = fragment.$internal;
  const adapter = deps.databaseAdapter;

  // Check if adapter supports prepareMigrations
  if (!adapter.prepareMigrations) {
    throw new Error(
      "Database adapter does not support prepareMigrations. Please use an adapter that implements this method.",
    );
  }

  const schema = deps.schema;
  const namespace = deps.namespace ?? schema.name;

  // Step 1: Ensure the internal fragment (settings table) is migrated first
  const internalFragment = getInternalFragment(adapter);

  if (!(await adapter.isConnectionHealthy())) {
    throw new Error(
      "Database connection is not healthy. Please check your database connection and try again.",
    );
  }

  const internalDeps = internalFragment.$internal.deps;
  const internalSchema = internalDeps.schema;
  // Internal fragment uses databaseNamespace: null (no table suffix).
  // Version tracking uses empty string so the key is ".schema_version",
  // which matches both the legacy format and how the internal fragment was designed.
  const internalNamespace = internalDeps.namespace ?? "";

  const internalCurrentVersion = await getSchemaVersionFromDatabase(
    internalFragment,
    internalNamespace,
  );
  const systemMigrationVersion = await getSystemMigrationVersionFromDatabase(
    internalFragment,
    internalNamespace,
  );

  if (internalCurrentVersion > internalSchema.version) {
    throw new Error(
      `Cannot migrate internal settings backwards: current version (${internalCurrentVersion}) > target version (${internalSchema.version})`,
    );
  }

  const systemMigrations = adapter.prepareMigrations(internalSchema, internalNamespace);
  await systemMigrations.execute(internalCurrentVersion, internalSchema.version, {
    systemFromVersion: systemMigrationVersion,
  });

  // Step 2: Get current database version for this fragment's namespace
  const currentVersion = await getSchemaVersionFromDatabase(internalFragment, namespace);
  const systemFromVersion = await getSystemMigrationVersionFromDatabase(
    internalFragment,
    namespace,
  );

  // Step 3: Run the migration from current version to target version
  const targetVersion = schema.version;

  if (currentVersion > targetVersion) {
    throw new Error(
      `Cannot migrate backwards: current version (${currentVersion}) > target version (${targetVersion})`,
    );
  }

  const migrations = adapter.prepareMigrations(schema, namespace);
  await migrations.execute(currentVersion, targetVersion, {
    systemFromVersion,
  });
}
