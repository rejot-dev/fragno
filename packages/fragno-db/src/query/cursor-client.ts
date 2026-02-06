import type { AnyColumn } from "../schema/create";

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
    assertSerializableIndexValues(this.#indexValues);
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

const getBase64Helpers = () => {
  const { btoa, atob, TextEncoder, TextDecoder } = globalThis;

  if (!btoa || !atob) {
    throw new Error("Base64 helpers (btoa/atob) are not available in this environment.");
  }

  if (!TextEncoder || !TextDecoder) {
    throw new Error("TextEncoder/TextDecoder are required for cursor encoding.");
  }

  const encodeBase64 = (input: string): string => {
    const bytes = new TextEncoder().encode(input);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  };

  const decodeBase64 = (input: string): string => {
    const binary = atob(input);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  };

  return { encodeBase64, decodeBase64 };
};

/**
 * Encode cursor data to a base64 string (internal)
 */
function encodeCursorData(data: CursorData): string {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch (error) {
    throw new Error(`Invalid cursor: ${error instanceof Error ? error.message : "malformed data"}`);
  }

  return getBase64Helpers().encodeBase64(json);
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
    const json = getBase64Helpers().decodeBase64(cursor);
    const data = JSON.parse(json);
    const record = data as Record<string, unknown>;

    // Validate structure
    if (
      !isPlainObject(data) ||
      !isPlainObject(record["indexValues"]) ||
      typeof record["indexName"] !== "string" ||
      record["indexName"].length === 0 ||
      typeof record["orderDirection"] !== "string" ||
      (record["orderDirection"] !== "asc" && record["orderDirection"] !== "desc") ||
      typeof record["pageSize"] !== "number" ||
      !Number.isFinite(record["pageSize"]) ||
      !Number.isInteger(record["pageSize"]) ||
      record["pageSize"] <= 0
    ) {
      throw new Error("Invalid cursor structure");
    }

    // Only support v1
    if (typeof record["v"] !== "number") {
      throw new Error("Unsupported cursor version: missing. Only v1 is supported.");
    }
    const version = record["v"];
    if (version !== 1) {
      throw new Error(`Unsupported cursor version: ${version}. Only v1 is supported.`);
    }

    return new Cursor({
      indexName: record["indexName"],
      orderDirection: record["orderDirection"],
      pageSize: record["pageSize"],
      indexValues: record["indexValues"],
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
    const value = record[col.name];
    if (value === undefined) {
      throw new Error(`Record is missing value for index column "${col.name}".`);
    }
    indexValues[col.name] = value;
  }

  return new Cursor({
    indexName: metadata.indexName,
    orderDirection: metadata.orderDirection,
    pageSize: metadata.pageSize,
    indexValues,
  });
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertSerializableIndexValues = (values: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      throw new Error(`Cursor index value "${key}" is undefined.`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Cursor index value "${key}" must be a finite number.`);
    }
    if (typeof value === "bigint") {
      throw new Error(`Cursor index value "${key}" must not be a BigInt.`);
    }
    if (typeof value === "function" || typeof value === "symbol") {
      throw new Error(`Cursor index value "${key}" is not JSON-serializable.`);
    }
  }
};
