import type { SimpleQueryInterface } from "../query/simple-query-interface";
import type { AnySchema } from "../schema/create";
import type { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";
import type { IUnitOfWork } from "../query/unit-of-work/unit-of-work";
import type { PreparedMigrations } from "./generic-sql/migration/prepared-migrations";
import type { SQLProvider } from "../shared/providers";
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

/**
 * Maps logical table names (used by fragment authors) to physical table names (with namespace suffix)
 */
export interface TableNameMapper {
  toPhysical(logicalName: string): string;
  toLogical(physicalName: string): string;
}

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
   * Get current schema version, undefined if not initialized.
   */
  getSchemaVersion(namespace: string): Promise<string | undefined>;

  /**
   * Optional metadata used by schema output tooling.
   */
  readonly adapterMetadata?: DatabaseAdapterMetadata;

  createQueryEngine: <const T extends AnySchema>(
    schema: T,
    namespace: string,
  ) => SimpleQueryInterface<T, TUOWConfig>;

  prepareMigrations?: <const T extends AnySchema>(
    schema: T,
    namespace: string,
  ) => PreparedMigrations;

  /**
   * Creates a table name mapper for the given namespace.
   * Used to convert between logical table names and physical table names.
   */
  createTableNameMapper: (namespace: string) => TableNameMapper;

  isConnectionHealthy: () => Promise<boolean>;

  close: () => Promise<void>;
}
