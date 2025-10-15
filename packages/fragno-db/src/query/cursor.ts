import type { AnyColumn } from "../schema/create";
import { serialize } from "../schema/serialize";
import type { SQLProvider } from "../shared/providers";

/**
 * Cursor data structure containing index values and pagination direction
 */
export interface CursorData {
  /**
   * Values for each column in the index, keyed by column ORM name
   */
  indexValues: Record<string, unknown>;
  /**
   * Direction of pagination
   */
  direction: "forward" | "backward";
}

/**
 * Encode cursor data to a base64 string
 *
 * @param data - The cursor data to encode
 * @returns Base64-encoded cursor string
 *
 * @example
 * ```ts
 * const cursor = encodeCursor({
 *   indexValues: { id: "abc123", createdAt: 1234567890 },
 *   direction: "forward"
 * });
 * ```
 */
export function encodeCursor(data: CursorData): string {
  const json = JSON.stringify(data);
  // Use Buffer in Node.js or btoa in browsers
  if (typeof Buffer !== "undefined") {
    return Buffer.from(json, "utf-8").toString("base64");
  }
  return btoa(json);
}

/**
 * Decode a base64 cursor string back to cursor data
 *
 * @param cursor - The base64-encoded cursor string
 * @returns Decoded cursor data
 * @throws Error if cursor is invalid or malformed
 *
 * @example
 * ```ts
 * const data = decodeCursor("eyJpbmRleFZhbHVlcyI6e30sImRpcmVjdGlvbiI6ImZvcndhcmQifQ==");
 * ```
 */
export function decodeCursor(cursor: string): CursorData {
  try {
    let json: string;
    if (typeof Buffer !== "undefined") {
      json = Buffer.from(cursor, "base64").toString("utf-8");
    } else {
      json = atob(cursor);
    }
    const data = JSON.parse(json);

    // Validate structure
    if (
      !data ||
      typeof data !== "object" ||
      !data.indexValues ||
      typeof data.indexValues !== "object" ||
      (data.direction !== "forward" && data.direction !== "backward")
    ) {
      throw new Error("Invalid cursor structure");
    }

    return data as CursorData;
  } catch (error) {
    throw new Error(`Invalid cursor: ${error instanceof Error ? error.message : "malformed data"}`);
  }
}

/**
 * Create a cursor from a record and index columns
 *
 * @param record - The database record
 * @param indexColumns - The columns that make up the index
 * @param direction - The pagination direction
 * @returns Encoded cursor string
 *
 * @example
 * ```ts
 * const cursor = createCursorFromRecord(
 *   { id: "abc", name: "Alice", createdAt: 123 },
 *   [table.columns.createdAt, table.columns.id],
 *   "forward"
 * );
 * ```
 */
export function createCursorFromRecord(
  record: Record<string, unknown>,
  indexColumns: AnyColumn[],
  direction: "forward" | "backward",
): string {
  const indexValues: Record<string, unknown> = {};

  for (const col of indexColumns) {
    indexValues[col.ormName] = record[col.ormName];
  }

  return encodeCursor({ indexValues, direction });
}

/**
 * Serialize cursor values for database queries
 *
 * Converts cursor values (which are in application format) to database format
 * using the column serialization rules.
 *
 * @param cursorData - The decoded cursor data
 * @param indexColumns - The columns that make up the index
 * @param provider - The SQL provider
 * @returns Serialized values ready for database queries
 *
 * @example
 * ```ts
 * const serialized = serializeCursorValues(
 *   cursorData,
 *   [table.columns.createdAt],
 *   "postgresql"
 * );
 * ```
 */
export function serializeCursorValues(
  cursorData: CursorData,
  indexColumns: AnyColumn[],
  provider: SQLProvider,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};

  for (const col of indexColumns) {
    const value = cursorData.indexValues[col.ormName];
    if (value !== undefined) {
      serialized[col.ormName] = serialize(value, col, provider);
    }
  }

  return serialized;
}
