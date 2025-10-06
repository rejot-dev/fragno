import type { Migrator } from "../migration-engine/create";
import type { AbstractQuery } from "../query/query";
import type { AnySchema } from "../schema/create";

export interface DatabaseAdapter {
  /**
   * Get current schema version, undefined if not initialized.
   */
  getSchemaVersion(namespace: string): Promise<string | undefined>;

  createMigrationEngine?: <const T extends AnySchema>(schema: T, namespace: string) => Migrator;

  createQueryEngine: <const T extends AnySchema>(schema: T, namespace: string) => AbstractQuery<T>;
}
