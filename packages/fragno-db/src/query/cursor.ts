import type { AnyColumn } from "../schema/create";
import { deserialize, serialize } from "../schema/serialize";
import type { SQLProvider } from "../shared/providers";

/**
 * Cursor object containing all information needed for pagination
 */
export class Cursor {
  readonly #indexName: string;
  readonly #orderDirection: "asc" | "desc";
  readonly #pageSize: number;
  readonly #indexValues: Record<string, unknown>;

  constructor(data: {
    indexName: string;
    orderDirection: "asc" | "desc";
    pageSize: number;
    indexValues: Record<string, unknown>;
  }) {
    this.#indexName = data.indexName;
    this.#orderDirection = data.orderDirection;
    this.#pageSize = data.pageSize;
    this.#indexValues = data.indexValues;
  }

  /**
   * Get the index name being used for pagination
   */
  get indexName(): string {
    return this.#indexName;
  }

  /**
   * Get the ordering direction
   */
  get orderDirection(): "asc" | "desc" {
    return this.#orderDirection;
  }

  /**
   * Get the page size
   */
  get pageSize(): number {
    return this.#pageSize;
  }

  /**
   * Get the cursor position values
   */
  get indexValues(): Record<string, unknown> {
    return this.#indexValues;
  }

  /**
   * Encode cursor to an opaque base64 string (safe to send to client)
   */
  encode(): string {
    const data: CursorData = {
      v: 1,
      indexName: this.#indexName,
      orderDirection: this.#orderDirection,
      pageSize: this.#pageSize,
      indexValues: this.#indexValues,
    };
    return encodeCursorData(data);
  }
}

/**
 * Result of a cursor-based query containing items and pagination cursor
 */
export interface CursorResult<T> {
  /**
   * The query results
   */
  items: T[];
  /**
   * Cursor to fetch the next page (undefined if no more results)
   */
  cursor?: Cursor;
  /**
   * Whether there are more results available after this page
   */
  hasNextPage: boolean;
}

/**
 * Cursor data structure for serialization
 */
export interface CursorData {
  v: number; // version
  indexName: string;
  orderDirection: "asc" | "desc";
  pageSize: number;
  indexValues: Record<string, unknown>;
}

/**
 * Encode cursor data to a base64 string (internal)
 */
function encodeCursorData(data: CursorData): string {
  const json = JSON.stringify(data);
  // Use Buffer in Node.js or btoa in browsers
  if (typeof Buffer !== "undefined") {
    return Buffer.from(json, "utf-8").toString("base64");
  }
  return btoa(json);
}

/**
 * Decode a base64 cursor string back to a Cursor object
 *
 * @param cursor - The base64-encoded cursor string
 * @returns Decoded Cursor object
 * @throws Error if cursor is invalid or malformed
 *
 * @example
 * ```ts
 * const cursor = decodeCursor("eyJpbmRleFZhbHVlcyI6e30sImRpcmVjdGlvbiI6ImZvcndhcmQifQ==");
 * ```
 */
export function decodeCursor(cursor: string): Cursor {
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
      typeof data.pageSize !== "number" ||
      !data.indexName ||
      !data.orderDirection ||
      (data.orderDirection !== "asc" && data.orderDirection !== "desc")
    ) {
      throw new Error("Invalid cursor structure");
    }

    // Only support v1
    const version = typeof data.v === "number" ? data.v : 0;
    if (version !== 1) {
      throw new Error(`Unsupported cursor version: ${version}. Only v1 is supported.`);
    }

    return new Cursor({
      indexName: data.indexName,
      orderDirection: data.orderDirection,
      pageSize: data.pageSize,
      indexValues: data.indexValues,
    });
  } catch (error) {
    throw new Error(`Invalid cursor: ${error instanceof Error ? error.message : "malformed data"}`);
  }
}

/**
 * Create a cursor from a record and pagination metadata
 *
 * @param record - The database record
 * @param indexColumns - The columns that make up the index
 * @param metadata - Pagination metadata (index name, order direction, page size)
 * @returns Cursor object
 *
 * @example
 * ```ts
 * const cursor = createCursorFromRecord(
 *   { id: "abc", name: "Alice", createdAt: 123 },
 *   [table.columns.createdAt, table.columns.id],
 *   {
 *     indexName: "idx_created",
 *     orderDirection: "asc",
 *     pageSize: 10
 *   }
 * );
 * ```
 */
export function createCursorFromRecord(
  record: Record<string, unknown>,
  indexColumns: AnyColumn[],
  metadata: {
    indexName: string;
    orderDirection: "asc" | "desc";
    pageSize: number;
  },
): Cursor {
  const indexValues: Record<string, unknown> = {};

  for (const col of indexColumns) {
    indexValues[col.ormName] = record[col.ormName];
  }

  return new Cursor({
    indexName: metadata.indexName,
    orderDirection: metadata.orderDirection,
    pageSize: metadata.pageSize,
    indexValues,
  });
}

/**
 * Serialize cursor values for database queries
 *
 * Converts cursor values (which are in JSON-compatible format after decode)
 * to database format using the column serialization rules.
 *
 * This function performs a two-step process:
 * 1. Deserialize from JSON format to application format (e.g., ISO string → Date)
 * 2. Serialize from application format to database format (e.g., Date → driver format)
 *
 * @param cursor - The cursor object
 * @param indexColumns - The columns that make up the index
 * @param provider - The SQL provider
 * @returns Serialized values ready for database queries
 *
 * @example
 * ```ts
 * const serialized = serializeCursorValues(
 *   cursor,
 *   [table.columns.createdAt],
 *   "postgresql"
 * );
 * ```
 */
export function serializeCursorValues(
  cursor: Cursor,
  indexColumns: AnyColumn[],
  provider: SQLProvider,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};

  for (const col of indexColumns) {
    const value = cursor.indexValues[col.ormName];
    if (value !== undefined) {
      // First deserialize from JSON format to application format
      // (e.g., "2025-11-07T09:36:57.959Z" string → Date object)
      const deserialized = deserialize(value, col, provider);
      // Then serialize to database format
      // (e.g., Date → database driver format)
      serialized[col.ormName] = serialize(deserialized, col, provider);
    }
  }

  return serialized;
}
