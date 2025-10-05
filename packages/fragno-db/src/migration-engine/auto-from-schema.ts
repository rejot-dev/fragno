import { compileForeignKey, type AnySchema } from "../schema/create";
import type { MigrationOperation } from "./shared";

/**
 * Generate migration operations from a schema's operation history
 *
 * The schema version number represents the cumulative number of operations applied.
 * This function takes operations from the schema between fromVersion and toVersion,
 * and converts them into migration operations.
 *
 * @param targetSchema - The schema containing the operations history
 * @param fromVersion - The current database version (e.g., 0)
 * @param toVersion - The target version to migrate to (e.g., 5)
 * @param options - Migration generation options
 * @returns Array of migration operations to apply
 *
 * @example
 * ```ts
 * const mySchema = schema(s => s
 *   .addTable("users", t => t.addColumn("id", idColumn()))       // version 1
 *   .addTable("posts", t => t.addColumn("id", idColumn()))       // version 2
 * );
 *
 * // Generate operations from version 0 to 1 (only creates users table)
 * const operations = generateMigrationFromSchema(mySchema, 0, 1);
 * ```
 */
export function generateMigrationFromSchema(
  targetSchema: AnySchema,
  fromVersion: number,
  toVersion: number,
): MigrationOperation[] {
  if (fromVersion < 0) {
    throw new Error(`fromVersion cannot be negative: ${fromVersion}`);
  }

  if (fromVersion > targetSchema.version) {
    throw new Error(
      `fromVersion (${fromVersion}) exceeds schema version (${targetSchema.version})`,
    );
  }

  if (toVersion > targetSchema.version) {
    throw new Error(`toVersion (${toVersion}) exceeds schema version (${targetSchema.version})`);
  }

  if (toVersion < fromVersion) {
    throw new Error(
      `Cannot migrate backwards: toVersion (${toVersion}) < fromVersion (${fromVersion})`,
    );
  }

  // Get operations between fromVersion and toVersion
  // Operations are 1-indexed (operation 0 is version 0→1)
  const relevantOperations = targetSchema.operations.slice(fromVersion, toVersion);

  // Convert schema operations to migration operations
  const migrationOperations: MigrationOperation[] = [];

  for (const op of relevantOperations) {
    if (op.type === "add-table") {
      migrationOperations.push({
        type: "create-table",
        value: op.table,
      });
    } else if (op.type === "add-reference") {
      const table = targetSchema.tables[op.tableName];
      if (!table) {
        throw new Error(`Table ${op.tableName} not found in schema`);
      }

      // Find the foreign key that matches this reference
      const foreignKey = table.foreignKeys.find(
        (fk) => fk.name === `${op.tableName}_${op.config.targetTable}_${op.referenceName}_fk`,
      );

      if (!foreignKey) {
        throw new Error(
          `Foreign key for reference ${op.referenceName} not found in table ${op.tableName}`,
        );
      }

      migrationOperations.push({
        type: "add-foreign-key",
        table: op.tableName,
        value: compileForeignKey(foreignKey),
      });
    } else if (op.type === "add-index") {
      migrationOperations.push({
        type: "add-index",
        table: op.tableName,
        name: op.name,
        columns: op.columns,
        unique: op.unique,
      });
    }
  }

  return migrationOperations;
}
