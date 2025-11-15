import type { Migrator } from "../migration-engine/create";
import type { AbstractQuery } from "../query/query";
import type { SchemaGenerator } from "../schema-generator/schema-generator";
import type { AnySchema } from "../schema/create";
import type { RequestContextStorage } from "@fragno-dev/core/api/request-context-storage";
import type { IUnitOfWorkBase } from "../query/unit-of-work";

export const fragnoDatabaseAdapterNameFakeSymbol = "$fragno-database-adapter-name" as const;
export const fragnoDatabaseAdapterVersionFakeSymbol = "$fragno-database-adapter-version" as const;

/**
 * Storage type for database context - stores the Unit of Work.
 * This is shared across all fragments using the same adapter.
 */
export type DatabaseContextStorage = {
  uow: IUnitOfWorkBase;
};

/**
 * Maps logical table names (used by fragment authors) to physical table names (with namespace suffix)
 */
export interface TableNameMapper {
  toPhysical(logicalName: string): string;
  toLogical(physicalName: string): string;
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

  createQueryEngine: <const T extends AnySchema>(
    schema: T,
    namespace: string,
  ) => AbstractQuery<T, TUOWConfig>;

  createMigrationEngine?: <const T extends AnySchema>(schema: T, namespace: string) => Migrator;

  /**
   * Generate a combined schema file from one or more fragments.
   * If not implemented, schema generation is not supported for this adapter.
   */
  createSchemaGenerator?: (
    fragments: { schema: AnySchema; namespace: string }[],
    options?: { path?: string },
  ) => SchemaGenerator;

  /**
   * Creates a table name mapper for the given namespace.
   * Used to convert between logical table names and physical table names.
   */
  createTableNameMapper: (namespace: string) => TableNameMapper;

  isConnectionHealthy: () => Promise<boolean>;

  close: () => Promise<void>;
}
