import { type AnySchema } from "../schema/create";
import type { MigrationOperation, ColumnInfo } from "./shared";

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
      // Collect columns for create-table operation
      const columns: ColumnInfo[] = [];

      for (const subOp of op.operations) {
        if (subOp.type === "add-column") {
          const col = subOp.column;
          columns.push({
            name: subOp.columnName,
            type: col.type,
            isNullable: col.isNullable,
            role: col.role,
            default: col.default
              ? {
                  value: "value" in col.default ? col.default.value : undefined,
                  runtime:
                    "runtime" in col.default
                      ? typeof col.default.runtime === "string"
                        ? col.default.runtime
                        : undefined
                      : undefined,
                }
              : undefined,
          });
        }
      }

      migrationOperations.push({
        type: "create-table",
        name: op.tableName,
        columns,
      });

      // Add indexes and foreign keys as separate operations
      for (const subOp of op.operations) {
        if (subOp.type === "add-index") {
          migrationOperations.push({
            type: "add-index",
            table: op.tableName,
            name: subOp.name,
            columns: subOp.columns,
            unique: subOp.unique,
          });
        } else if (subOp.type === "add-foreign-key") {
          migrationOperations.push({
            type: "add-foreign-key",
            table: op.tableName,
            value: {
              name: subOp.name,
              columns: subOp.columns,
              referencedTable: subOp.referencedTable,
              referencedColumns: subOp.referencedColumns,
            },
          });
        }
      }
    } else if (op.type === "alter-table") {
      const columnOps = op.operations.filter((o) => o.type === "add-column");

      if (columnOps.length > 0) {
        migrationOperations.push({
          type: "alter-table",
          name: op.tableName,
          value: columnOps.map((o) => {
            const col = o.column;
            return {
              type: "create-column" as const,
              value: {
                name: o.columnName,
                type: col.type,
                isNullable: col.isNullable,
                role: col.role,
                default: col.default
                  ? {
                      value: "value" in col.default ? col.default.value : undefined,
                      runtime:
                        "runtime" in col.default
                          ? typeof col.default.runtime === "string"
                            ? col.default.runtime
                            : undefined
                          : undefined,
                    }
                  : undefined,
              },
            };
          }),
        });
      }

      // Add indexes as separate operations
      for (const subOp of op.operations) {
        if (subOp.type === "add-index") {
          migrationOperations.push({
            type: "add-index",
            table: op.tableName,
            name: subOp.name,
            columns: subOp.columns,
            unique: subOp.unique,
          });
        }
      }
    } else if (op.type === "add-reference") {
      migrationOperations.push({
        type: "add-foreign-key",
        table: op.tableName,
        value: {
          name: `${op.tableName}_${op.config.targetTable}_${op.referenceName}_fk`,
          columns: op.config.columns,
          referencedTable: op.config.targetTable,
          referencedColumns: op.config.targetColumns,
        },
      });
    }
  }

  return migrationOperations;
}
