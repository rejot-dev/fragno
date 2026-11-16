import { sql, type RawBuilder } from "kysely";

import { DURABLE_OBJECT_MAX_VALUE_BYTES } from "../../../sql-driver/dialects/durable-object-limits";
import type { DriverConfig } from "../driver-config";

// Half of what Durable Object SQLite holds in one value, so a value that fits a row fits a chunk.
const MAX_JSON_LIST_BYTES = DURABLE_OBJECT_MAX_VALUE_BYTES / 2;

/**
 * The right-hand side of an `in` or `not in` comparison with `values`, already serialized for the
 * database.
 *
 * SQLite gets the list as JSON parameters, read back by `json_each`, because Durable Object SQLite
 * binds at most 100 parameters per statement: the list can then be any length, in one statement,
 * so ordering, page sizes, and cursors hold as for a short one. A long list is split over several
 * JSON parameters, as Durable Object SQLite also caps the bytes of each. The values compare as
 * bound parameters would, taking the column's affinity, and SQLite still searches the column's
 * index for each.
 *
 * JSON holds no bytes, so a list holding any, such as of BLOB-stored bigints, binds a parameter per
 * value, as do lists on the other databases, which bind tens of thousands.
 */
export function bindInList(
  values: readonly unknown[],
  driverConfig: DriverConfig,
): readonly unknown[] | RawBuilder<unknown> {
  if (!bindsListsAsOne(driverConfig) || !values.every(isJsonScalar)) {
    return values;
  }
  const selects = jsonChunks(values).map((json) => sql`select value from json_each(${json})`);
  return sql`(${sql.join(selects, sql` union all `)})`;
}

/** Whether an `in` list of strings and numbers binds as JSON, however long it is. */
export function bindsListsAsOne(driverConfig: DriverConfig): boolean {
  return driverConfig.databaseType === "sqlite";
}

/** `values` as JSON arrays of at most `MAX_JSON_LIST_BYTES` each, but for a single larger value. */
function jsonChunks(values: readonly (string | number | bigint | null)[]): string[] {
  // Written by hand, as `JSON.stringify` refuses bigints; SQLite reads JSON integers as 64-bit.
  const items = values.map((value) =>
    typeof value === "bigint" ? value.toString() : JSON.stringify(value),
  );
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk: string[] = [];
  let chunkBytes = 2;
  for (const item of items) {
    const itemBytes = encoder.encode(item).byteLength + 1;
    if (chunk.length > 0 && chunkBytes + itemBytes > MAX_JSON_LIST_BYTES) {
      chunks.push(`[${chunk.join(",")}]`);
      chunk = [];
      chunkBytes = 2;
    }
    chunk.push(item);
    chunkBytes += itemBytes;
  }
  chunks.push(`[${chunk.join(",")}]`);
  return chunks;
}

function isJsonScalar(value: unknown): value is string | number | bigint | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
