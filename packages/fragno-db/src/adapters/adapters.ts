import type { Migrator } from "../migration-engine/create";
import type { AbstractQuery } from "../query";
import type { AnySchema } from "../schema/create";

export interface DatabaseAdapter {
  /**
   * Get current schema version, undefined if not initialized.
   */
  getSchemaVersion(): Promise<string | undefined>;

  createMigrationEngine?: (schema: AnySchema) => Migrator;

  createQueryEngine: (schema: AnySchema) => AbstractQuery<AnySchema>;
}
