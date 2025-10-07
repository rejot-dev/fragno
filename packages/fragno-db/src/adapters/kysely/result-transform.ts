import type { AnyTable } from "../../schema/create";
import type { SQLProvider } from "../../shared/providers";
import { deserialize, serialize } from "../../schema/serialize";

/**
 * Encodes a record of values from the application format to database format.
 *
 * This function transforms object keys to match SQL column names and serializes
 * values according to the database provider's requirements (e.g., converting
 * JavaScript Date objects to numbers for SQLite).
 *
 * @param values - The record of values to encode in application format
 * @param table - The table schema definition containing column information
 * @param generateDefault - Whether to generate default values for undefined columns
 * @param provider - The SQL provider (sqlite, postgresql, mysql, etc.)
 * @returns A record with database-compatible column names and serialized values
 *
 * @example
 * ```ts
 * const encoded = encodeValues(
 *   { userId: 123, createdAt: new Date() },
 *   userTable,
 *   true,
 *   'sqlite'
 * );
 * // Returns: { user_id: 123, created_at: 1234567890 }
 * ```
 */
export function encodeValues(
  values: Record<string, unknown>,
  table: AnyTable,
  generateDefault: boolean,
  provider: SQLProvider,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const k in table.columns) {
    const col = table.columns[k];
    let value = values[k];

    if (generateDefault && value === undefined) {
      // prefer generating them on runtime to avoid SQLite's problem with column default value being ignored when insert
      value = col.generateDefaultValue();
    }

    if (value !== undefined) {
      result[col.name] = serialize(value, col, provider);
    }
  }

  return result;
}

/**
 * Decodes a database result record to application format.
 *
 * This function transforms database column names back to application property names
 * and deserializes values according to the database provider's format (e.g., converting
 * SQLite integers back to JavaScript Date objects).
 *
 * Supports relation data encoded with the pattern `relationName:columnName`.
 *
 * @param result - The raw database result record
 * @param table - The table schema definition containing column and relation information
 * @param provider - The SQL provider (sqlite, postgresql, mysql, etc.)
 * @returns A record in application format with deserialized values
 *
 * @example
 * ```ts
 * const decoded = decodeResult(
 *   { user_id: 123, created_at: 1234567890, 'posts:title': 'Hello' },
 *   userTable,
 *   'sqlite'
 * );
 * // Returns: { userId: 123, createdAt: Date, posts: { title: 'Hello' } }
 * ```
 */
export function decodeResult(
  result: Record<string, unknown>,
  table: AnyTable,
  provider: SQLProvider,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const k in result) {
    const segments = k.split(":", 2);
    const value = result[k];

    if (segments.length === 1) {
      output[k] = deserialize(value, table.columns[k]!, provider);
    }

    if (segments.length === 2) {
      const [relationName, colName] = segments;
      const relation = table.relations[relationName];
      if (relation === undefined) {
        continue;
      }

      const col = relation.table.columns[colName];
      if (col === undefined) {
        continue;
      }

      output[relationName] ??= {};
      const obj = output[relationName] as Record<string, unknown>;
      obj[colName] = deserialize(value, col, provider);
    }
  }

  return output;
}
