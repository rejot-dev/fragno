import type { DatabaseAdapter } from "./adapters/adapters";
import type { AnySchema } from "./schema/create";
import type { AbstractQuery } from "./query/query";
import type { CursorResult } from "./query/cursor";
import { Cursor } from "./query/cursor";

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
    if (!this.#adapter.createMigrationEngine) {
      throw new Error("Migration engine not supported for this adapter.");
    }

    const migrator = this.#adapter.createMigrationEngine(this.#schema, this.#namespace);
    const preparedMigration = await migrator.prepareMigration();
    await preparedMigration.execute();

    return preparedMigration.operations.length > 0;
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
  withDatabase,
  DatabaseFragmentDefinitionBuilder,
  type FragnoPublicConfigWithDatabase,
  type DatabaseFragmentContext,
  type DatabaseHandlerContext as DatabaseRequestContext,
  type ImplicitDatabaseDependencies,
} from "./db-fragment-definition-builder";

export { decodeCursor, type CursorData } from "./query/cursor";

export {
  createUnitOfWork,
  UnitOfWork,
  UnitOfWorkSchemaView,
  UnitOfWorkRestrictedSchemaView,
  RestrictedUnitOfWork,
  restrictUnitOfWork,
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

export { type BoundServices } from "@fragno-dev/core";
