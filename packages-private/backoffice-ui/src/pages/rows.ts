import type {
  PageColumn,
  PageColumns,
  PageLiteral,
  PageQuery,
  PageScalarColumn,
  PageValue,
} from "./definition";

/** A value as the interface reads it: JSON, with times as ISO 8601 strings. */
export type PageData = PageLiteral | PageData[] | { [field: string]: PageData };

/** What SQLite returned for a query: its column names, and each row's values in their order. */
export type PageQueryResult = {
  columns: readonly string[];
  rows: readonly (readonly unknown[])[];
};

/** A query's parameters at `now`: times relative to it become milliseconds since the epoch. */
export function pageQueryParams(query: PageQuery, now: number): PageLiteral[] {
  return query.params.map((param) =>
    param !== null && typeof param === "object" ? now + param.now : param,
  );
}

/** A query's rows did not hold what its columns declare. */
export class PageRowsError extends Error {}

/**
 * The rows a query's columns declare, decoded from what SQLite returned: times become ISO 8601
 * strings, 0 and 1 booleans, and JSON text values. SQL is a string no type checker sees into, so a
 * value that does not fit its declaration throws rather than reach a component as something else.
 */
export function pageRows(query: PageQuery, result: PageQueryResult): PageData[] {
  const indexes = Object.keys(query.columns).map((name) => {
    const index = result.columns.indexOf(name);
    if (index === -1) {
      throw new PageRowsError(
        `The query declares a "${name}" column, which it does not select. It selects: ${result.columns.join(", ")}.`,
      );
    }
    return [name, index] as const;
  });
  return result.rows.map((row, rowIndex) =>
    Object.fromEntries(
      indexes.map(([name, index]) => [
        name,
        decode(query.columns[name], row[index], {
          path: `Column "${name}" of row ${rowIndex + 1}`,
          json: false,
        }),
      ]),
    ),
  );
}

/** A value's field of its query's first row, or its stated value when the query has no rows. */
export function pageValue({ field, whenEmpty }: PageValue, rows: readonly PageData[]): PageData {
  const [first] = rows;
  return first === undefined ? whenEmpty : ((first as Record<string, PageData>)[field] ?? null);
}

/** Where a value sits, and whether it came out of JSON rather than straight from SQLite. */
type Place = { path: string; json: boolean };

function decode(column: PageColumn, value: unknown, place: Place): PageData {
  if (typeof column === "string") {
    const nullable = column.endsWith("?");
    if (value === null || value === undefined) {
      if (nullable) {
        return null;
      }
      throw mismatch(place, column, value);
    }
    return decodeScalar(column.replace(/\?$/u, "") as PageScalarColumn, value, place);
  }
  if (Array.isArray(column)) {
    const options = column as readonly (string | null)[];
    const known = value === undefined ? null : value;
    if (options.includes(known as string | null)) {
      return known as string | null;
    }
    throw new PageRowsError(
      `${place.path} holds ${describe(value)}, which is not one of ${options.map((option) => JSON.stringify(option)).join(", ")}.`,
    );
  }
  return decodeRows((column as { rows: PageColumns }).rows, value, place);
}

function decodeScalar(type: PageScalarColumn, value: unknown, place: Place): PageData {
  switch (type) {
    case "string":
      if (typeof value === "string") {
        return value;
      }
      break;
    case "number":
      if (typeof value === "number") {
        return value;
      }
      if (typeof value === "bigint" && Number.isSafeInteger(Number(value))) {
        return Number(value);
      }
      break;
    case "boolean":
      if (typeof value === "boolean") {
        return value;
      }
      if (value === 0 || value === 1) {
        return value === 1;
      }
      break;
    case "time":
      if (typeof value === "number" && Number.isFinite(value)) {
        return new Date(value).toISOString();
      }
      break;
    case "json":
      // Inside JSON, a value is JSON already.
      if (place.json) {
        return value as PageData;
      }
      if (typeof value === "string") {
        try {
          return JSON.parse(value) as PageData;
        } catch {
          throw new PageRowsError(
            `${place.path} is declared "json" but holds text that is not JSON.`,
          );
        }
      }
      break;
  }
  throw mismatch(place, type, value);
}

function decodeRows(columns: PageColumns, value: unknown, place: Place): PageData[] {
  let rows = value;
  if (typeof value === "string") {
    try {
      rows = JSON.parse(value);
    } catch {
      throw new PageRowsError(`${place.path} declares rows but holds text that is not JSON.`);
    }
  }
  if (!Array.isArray(rows)) {
    throw new PageRowsError(
      `${place.path} declares rows, a JSON array such as json_group_array(json_object(...)), but holds ${describe(value)}.`,
    );
  }
  return rows.map((row: unknown, index) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new PageRowsError(
        `${place.path}, row ${index + 1}, is ${describe(row)}, not an object such as json_object(...).`,
      );
    }
    const fields = row as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(columns).map(([name, column]) => {
        if (!Object.hasOwn(fields, name)) {
          throw new PageRowsError(
            `${place.path}, row ${index + 1}, has no "${name}" field. It has: ${Object.keys(fields).join(", ")}.`,
          );
        }
        return [
          name,
          decode(column, fields[name], {
            path: `${place.path}, row ${index + 1}, field "${name}"`,
            json: true,
          }),
        ];
      }),
    );
  });
}

function mismatch(place: Place, declared: string, value: unknown): PageRowsError {
  return new PageRowsError(`${place.path} is declared "${declared}" but holds ${describe(value)}.`);
}

function describe(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (value instanceof Uint8Array) {
    return "a blob";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "object") {
    return "an object";
  }
  const shown = JSON.stringify(typeof value === "bigint" ? Number(value) : value);
  return `${typeof value === "bigint" ? "number" : typeof value} ${shown.length > 60 ? `${shown.slice(0, 57)}...` : shown}`;
}
