import type { AnySchema } from "./create";
import { FragnoId } from "./create";

/**
 * Generate a new ID for a table without creating a record.
 * This is useful when you need to reference an ID before actually creating the record,
 * or when you need to pass the ID to external services.
 *
 * @example
 * ```ts
 * const userId = generateId(mySchema, "users");
 * // Use userId in related records or pass to external services
 * uow.create("users", { id: userId, name: "John" });
 * ```
 */
export function generateId<
  TSchema extends AnySchema,
  TableName extends keyof TSchema["tables"] & string,
>(schema: TSchema, tableName: TableName): FragnoId {
  const tableSchema = schema.tables[tableName];
  if (!tableSchema) {
    throw new Error(`Table ${tableName} not found in schema`);
  }

  const idColumn = tableSchema.getIdColumn();
  const generated = idColumn.generateDefaultValue();
  if (generated === undefined) {
    throw new Error(`ID column ${idColumn.ormName} on table ${tableName} has no default generator`);
  }

  if (typeof generated !== "string") {
    throw new Error(
      `ID column ${idColumn.ormName} on table ${tableName} has no default generator that generates a string.`,
    );
  }

  return FragnoId.fromExternal(generated, 0);
}
