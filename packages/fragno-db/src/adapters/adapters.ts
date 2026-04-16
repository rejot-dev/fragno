import type { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";

import type { FragnoDatabase } from "../fragno-database";
import type { SqlNamingStrategy } from "../naming/sql-naming";
import type { IUnitOfWork, TypedUnitOfWork } from "../query/unit-of-work/unit-of-work";
import type { AnySchema } from "../schema/create";
import type { SQLProvider } from "../shared/providers";
import type { PreparedMigrations } from "./generic-sql/migration/prepared-migrations";
import type { SQLiteStorageMode } from "./generic-sql/sqlite-storage";

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
   * Register a schema/namespace pair with the adapter for adapter-level bookkeeping
   * used by base UOWs and namespace-aware executor features.
   */
  registerSchema: <const T extends AnySchema>(schema: T, namespace: string | null) => void;

  createUnitOfWork: <const T extends AnySchema>(
    schema: T,
    namespace: string | null,
    name?: string,
    config?: TUOWConfig,
  ) => TypedUnitOfWork<T, [], unknown>;

  createBaseUnitOfWork: (name?: string, config?: TUOWConfig) => IUnitOfWork;

  /**
   * @deprecated Prefer adapter.createUnitOfWork(schema, namespace, ...) directly.
   */
  createQueryEngine: <const T extends AnySchema>(
    schema: T,
    namespace: string | null,
  ) => FragnoDatabase<T, TUOWConfig>;

  prepareMigrations?: <const T extends AnySchema>(
    schema: T,
    namespace: string | null,
  ) => PreparedMigrations;

  isConnectionHealthy: () => Promise<boolean>;

  close: () => Promise<void>;
}
