import type { Migrator } from "../migration-engine/create";
import type { AbstractQuery } from "../query/query";
import type { SchemaGenerator } from "../schema-generator/schema-generator";
import type { AnySchema } from "../schema/create";

export const fragnoDatabaseAdapterNameFakeSymbol = "$fragno-database-adapter-name" as const;
export const fragnoDatabaseAdapterVersionFakeSymbol = "$fragno-database-adapter-version" as const;

export interface DatabaseAdapter<TUOWConfig = void> {
  [fragnoDatabaseAdapterNameFakeSymbol]: string;
  [fragnoDatabaseAdapterVersionFakeSymbol]: number;

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

  isConnectionHealthy: () => Promise<boolean>;

  close: () => Promise<void>;
}
