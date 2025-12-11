import type { DatabaseAdapter } from "./adapters/adapters";
import type { AnySchema } from "./schema/create";
import type { AbstractQuery } from "./query/query";
import type { CursorResult } from "./query/cursor";
import { Cursor } from "./query/cursor";
import type { FragnoInstantiatedFragment, AnyFragnoInstantiatedFragment } from "@fragno-dev/core";
import type {
  FragnoPublicConfigWithDatabase,
  ImplicitDatabaseDependencies,
} from "./db-fragment-definition-builder";
import {
  getSchemaVersionFromDatabase,
  type InternalFragmentInstance,
} from "./fragments/internal-fragment";

export type { DatabaseAdapter, CursorResult };
export { Cursor };

export const fragnoDatabaseFakeSymbol = "$fragno-database" as const;
export const fragnoDatabaseLibraryVersion = "0.1" as const;

export interface CreateFragnoDatabaseDefinitionOptions<T extends AnySchema> {
  namespace: string;
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
  #namespace: string;
  #schema: T;
  #adapter: DatabaseAdapter<TUOWConfig>;

  constructor(options: { namespace: string; schema: T; adapter: DatabaseAdapter<TUOWConfig> }) {
    this.#namespace = options.namespace;
    this.#schema = options.schema;
    this.#adapter = options.adapter;
  }

  get [fragnoDatabaseFakeSymbol](): typeof fragnoDatabaseFakeSymbol {
    return fragnoDatabaseFakeSymbol;
  }

  async createClient(): Promise<AbstractQuery<T, TUOWConfig>> {
    const dbVersion = await this.#adapter.getSchemaVersion(this.#namespace);
    if (dbVersion !== this.#schema.version.toString()) {
      throw new Error(
        `Database is not at expected version. Did you forget to run migrations?` +
          ` Current version: ${dbVersion}, Expected version: ${this.#schema.version}`,
      );
    }

    return this.#adapter.createQueryEngine(this.#schema, this.#namespace);
  }

  async runMigrations(): Promise<boolean> {
    if (!this.#adapter.prepareMigrations) {
      throw new Error("Migration engine not supported for this adapter.");
    }

    // Get the current version from the database
    const currentVersionStr = await this.#adapter.getSchemaVersion(this.#namespace);
    const currentVersion = currentVersionStr ? parseInt(currentVersionStr) : 0;
    const targetVersion = this.#schema.version;

    // Check if migration is needed
    if (currentVersion >= targetVersion) {
      return false;
    }

    const preparedMigrations = this.#adapter.prepareMigrations(this.#schema, this.#namespace);
    const compiledMigration = preparedMigrations.compile(currentVersion, targetVersion);

    await preparedMigrations.execute(currentVersion, targetVersion);

    return compiledMigration.statements.length > 0;
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
} from "./query/unit-of-work";

export {
  type RetryPolicy,
  NoRetryPolicy,
  ExponentialBackoffRetryPolicy,
  LinearBackoffRetryPolicy,
} from "./query/retry-policy";

export {
  executeUnitOfWork,
  type ExecuteUnitOfWorkResult,
  type ExecuteUnitOfWorkCallbacks,
  type ExecuteUnitOfWorkOptions,
} from "./query/execute-unit-of-work";

export type { BoundServices } from "@fragno-dev/core";

export { internalFragmentDef } from "./fragments/internal-fragment";
export type { InternalFragmentInstance } from "./fragments/internal-fragment";

export {
  DatabaseFragnoInstantiatedFragment,
  databaseFragnoInstantiatedFragmentCreator,
} from "./db-fragment-instantiator";

export type AnyFragnoInstantiatedDatabaseFragment = FragnoInstantiatedFragment<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  ImplicitDatabaseDependencies<AnySchema>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  FragnoPublicConfigWithDatabase,
  // Ensure the fragment has the internal fragment linked
  { _fragno_internal: InternalFragmentInstance } & Record<string, AnyFragnoInstantiatedFragment>
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
export async function migrate(fragment: AnyFragnoInstantiatedDatabaseFragment): Promise<void> {
  const { options, deps, linkedFragments } = fragment.$internal;
  const adapter = options.databaseAdapter;

  // Check if adapter supports prepareMigrations
  if (!adapter.prepareMigrations) {
    throw new Error(
      "Database adapter does not support prepareMigrations. Please use an adapter that implements this method.",
    );
  }

  const schema = deps.schema;
  const namespace = deps.namespace;

  // Step 1: Ensure the internal fragment (settings table) is migrated first
  const internalFragment = linkedFragments._fragno_internal;

  if (!internalFragment) {
    throw new Error("Internal fragment not found. Please ensure the internal fragment is linked.");
  }

  if (!(await adapter.isConnectionHealthy())) {
    throw new Error(
      "Database connection is not healthy. Please check your database connection and try again.",
    );
  }

  const internalDeps = internalFragment.$internal.deps;
  const internalSchema = internalDeps.schema;
  const internalNamespace = internalDeps.namespace;

  const internalCurrentVersion = await getSchemaVersionFromDatabase(
    internalFragment,
    internalNamespace,
  );

  // Migrate internal fragment if needed
  if (internalCurrentVersion < internalSchema.version) {
    const internalMigrations = adapter.prepareMigrations(internalSchema, internalNamespace);
    await internalMigrations.execute(internalCurrentVersion, internalSchema.version);
  }

  // Step 2: Get current database version for this fragment's namespace
  const currentVersion = await getSchemaVersionFromDatabase(internalFragment, namespace);

  // Step 3: Run the migration from current version to target version
  const targetVersion = schema.version;

  if (currentVersion === targetVersion) {
    return;
  }

  if (currentVersion > targetVersion) {
    throw new Error(
      `Cannot migrate backwards: current version (${currentVersion}) > target version (${targetVersion})`,
    );
  }

  const migrations = adapter.prepareMigrations(schema, namespace);
  await migrations.execute(currentVersion, targetVersion);
}
