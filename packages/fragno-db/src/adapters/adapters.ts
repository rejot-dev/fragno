import type { SimpleQueryInterface } from "../query/simple-query-interface";
import type { AnySchema } from "../schema/create";
import type { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";
import type { IUnitOfWork } from "../query/unit-of-work/unit-of-work";
import type {
  PreparedMigrations,
  PrepareMigrationsOptions,
} from "./generic-sql/migration/prepared-migrations";
import type { SQLProvider } from "../shared/providers";
import type { SQLiteStorageMode } from "./generic-sql/sqlite-storage";
import type { SqlNamingStrategy } from "../naming/sql-naming";

export const fragnoDatabaseAdapterNameFakeSymbol = "$fragno-database-adapter-name" as const;
export const fragnoDatabaseAdapterVersionFakeSymbol = "$fragno-database-adapter-version" as const;

/**
 * Storage type for database context - stores the Unit of Work.
 * This is shared across all fragments using the same adapter.
 */
export type DatabaseContextStorage = {
  uow: IUnitOfWork;
};

export type SQLiteProfile = "default" | "prisma";

export interface DatabaseAdapterMetadata {
  databaseType?: SQLProvider;
  sqliteProfile?: SQLiteProfile;
  sqliteStorageMode?: SQLiteStorageMode;
}

export interface DatabaseAdapter<TUOWConfig = void> {
  [fragnoDatabaseAdapterNameFakeSymbol]: string;
  [fragnoDatabaseAdapterVersionFakeSymbol]: number;

  /**
   * Request context storage shared across all fragments using this adapter.
   * This allows multiple fragments to participate in the same Unit of Work.
   */
  readonly contextStorage: RequestContextStorage<DatabaseContextStorage>;

  /**
   * Optional adapter override used for durable hook processing.
   * Use this when the public adapter wraps another adapter (e.g. model checker).
   */
  getHookProcessingAdapter?: () => DatabaseAdapter<TUOWConfig>;

  /**
   * Get current schema version, undefined if not initialized.
   */
  getSchemaVersion(namespace: string): Promise<string | undefined>;

  /**
   * Optional metadata used by schema output tooling.
   */
  readonly adapterMetadata?: DatabaseAdapterMetadata;

  /**
   * Naming strategy used for physical SQL identifiers.
   */
  readonly namingStrategy: SqlNamingStrategy;

  /**
   * @deprecated Avoid using query engines directly in fragment code. Prefer handlerTx/serviceTx.
   */
  createQueryEngine: <const T extends AnySchema>(
    schema: T,
    namespace: string | null,
  ) => SimpleQueryInterface<T, TUOWConfig>;

  prepareMigrations?: <const T extends AnySchema>(
    schema: T,
    namespace: string | null,
    options?: PrepareMigrationsOptions,
  ) => PreparedMigrations;

  isConnectionHealthy: () => Promise<boolean>;

  close: () => Promise<void>;
}
