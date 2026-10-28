import { z } from "zod";

import type { BackofficeUiSpec } from "../catalog";
import { INTERVAL_LIMITS } from "../components/intervals";
import { parseBackofficeUiResult } from "../result";

export const PAGE_LIMITS = {
  titleLength: 80,
  queries: 16,
  values: 32,
  /** Characters of one query's SQL. */
  sqlLength: 20_000,
  /** Values one query binds, a list counting as one: Durable Object SQLite binds at most 100. */
  params: 100,
  /** Columns one query declares, counting those of nested rows. */
  columns: 64,
  /** How deep nested rows declared with `{ rows }` may nest. */
  nestedRows: 3,
  /** Rows a query shows; it drops the rest. */
  rowsPerQuery: 500,
  buckets: INTERVAL_LIMITS.count,
  minimumBucketMs: INTERVAL_LIMITS.minimumMs,
  listItems: 100,
} as const;

export type PageLiteral = string | number | boolean | null;

/** How a column reads: as text, a number, 0 or 1, milliseconds since the epoch, or JSON text. */
export type PageScalarColumn = "string" | "number" | "boolean" | "time" | "json";

/**
 * A query's column as the page declares it: a scalar, or a nullable one such as `"time?"`; one of
 * listed strings, with null when listed; or JSON text holding rows, such as a
 * `json_group_array(json_object(...))` of each row's runs, with each field's own declaration.
 */
export type PageColumn =
  | PageScalarColumn
  | `${PageScalarColumn}?`
  | readonly (string | null)[]
  | { rows: PageColumns };

export type PageColumns = { readonly [name: string]: PageColumn };

/** A value a query binds: a literal, or a time relative to the moment the page renders. */
export type PageParam = PageLiteral | { now: number };

/**
 * One live query: a SQL SELECT over the scope's relations, whose `?1`, `?2`, ... are `params`, and
 * the columns its rows show.
 */
export type PageQuery = {
  sql: string;
  params: PageParam[];
  columns: PageColumns;
};

/** One field of a query's first row, such as a count for a metric. */
export type PageValue = { query: string; field: string; whenEmpty: PageLiteral };

/** A built page: its title, named live queries and values, and the interface bound to them. */
export type PageDefinition = {
  title: string;
  queries: Record<string, PageQuery>;
  values: Record<string, PageValue>;
  spec: BackofficeUiSpec;
};

/** A page as its route loads it: built from its source, or the build's error. */
export type PageLoad =
  | { kind: "missing" }
  | { kind: "ready"; definition: PageDefinition }
  | { kind: "failed"; message: string };

export type PageParseResult =
  | { kind: "valid"; definition: PageDefinition }
  | { kind: "invalid"; message: string };

/** Where a query's rows live in the interface's state, e.g. `{ "$state": "/data/q0" }`. */
export function pageDataPath(query: string): string {
  return `/data/${query}`;
}

/** Where a value lives in the interface's state, e.g. `{ "$state": "/values/v0" }`. */
export function pageValuePath(value: string): string {
  return `/values/${value}`;
}

/** Builds of an older version fail validation, so the system rebuilds them from source. */
export const PAGE_DEFINITION_VERSION = 5;

/** The scalar column types, as `PageScalarColumn` lists them. */
export const PAGE_SCALAR_COLUMNS = ["string", "number", "boolean", "time", "json"] as const;

const nameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Start with a letter and use letters, digits, and _.");

/** Named entries, at most `limit` of them. */
function namedSchema<T extends z.ZodType>(entry: T, limit: number) {
  return z
    .record(nameSchema, entry)
    .refine((record) => Object.keys(record).length <= limit, `At most ${limit} entries.`);
}

const literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null()], {
  error: "Expected a string, finite number, boolean, or null.",
});

const columnMessage = `Declare a column as one of ${PAGE_SCALAR_COLUMNS.map((type) => `"${type}"`).join(", ")}, with ? when it may be null; a list of the strings it holds; or { rows: { ...columns } }.`;

const columnSchema: z.ZodType<PageColumn> = z.lazy(() =>
  z.union(
    [
      z.enum([...PAGE_SCALAR_COLUMNS, ...PAGE_SCALAR_COLUMNS.map((type) => `${type}?` as const)]),
      z
        .array(z.string().or(z.null()))
        .min(1)
        .max(PAGE_LIMITS.listItems, `Lists hold at most ${PAGE_LIMITS.listItems} items.`),
      z.strictObject({ rows: namedSchema(columnSchema, PAGE_LIMITS.columns) }),
    ],
    { error: columnMessage },
  ),
);

const paramSchema = z.union([literalSchema, z.strictObject({ now: z.number() })], {
  error: "Expected a literal, or a time relative to now.",
});

const querySchema = z.strictObject({
  sql: z
    .string()
    .min(1, "Write the query's SQL.")
    .max(PAGE_LIMITS.sqlLength, `At most ${PAGE_LIMITS.sqlLength} characters of SQL.`),
  params: z
    .array(paramSchema)
    .max(PAGE_LIMITS.params, `A query binds at most ${PAGE_LIMITS.params} values.`),
  columns: namedSchema(columnSchema, PAGE_LIMITS.columns).refine(
    (columns) => Object.keys(columns).length > 0,
    "Declare the columns the query's rows show.",
  ),
});

/** A definition's shape; which columns its values name is checked once it parses. */
const pageFileSchema = z.strictObject({
  version: z.literal(PAGE_DEFINITION_VERSION),
  title: z
    .string()
    .trim()
    .min(1, 'Name the page, such as "Home".')
    .max(PAGE_LIMITS.titleLength, `At most ${PAGE_LIMITS.titleLength} characters.`),
  queries: namedSchema(querySchema, PAGE_LIMITS.queries),
  values: namedSchema(
    z.strictObject({ query: z.string(), field: z.string(), whenEmpty: literalSchema }),
    PAGE_LIMITS.values,
  ),
  spec: z.unknown(),
});

/**
 * Validates what `page.define` returned, or what a cached build holds. Whether each query's SQL
 * runs over the scope's relations and returns its declared columns is the host's to check, as it
 * knows the relations.
 */
export function parsePageDefinition(json: unknown): PageParseResult {
  if (
    isRecord(json) &&
    typeof json.version === "number" &&
    json.version < PAGE_DEFINITION_VERSION
  ) {
    return {
      kind: "invalid",
      message: `version: The page was built with an older page format, version ${json.version}.`,
    };
  }
  const file = pageFileSchema.safeParse(json);
  if (!file.success) {
    const [issue] = file.error.issues;
    const path = issue.path.map(String).join(".");
    return { kind: "invalid", message: path ? `${path}: ${issue.message}` : issue.message };
  }
  const { title, queries, values, spec } = file.data;
  const problem = pageProblem(queries, values);
  if (problem !== null) {
    return { kind: "invalid", message: problem };
  }

  const ui = parseBackofficeUiResult({ $ui: { version: 1, state: {}, spec } });
  if (ui.kind === "ordinary") {
    throw new Error("A $ui envelope always parses as generated UI.");
  }
  if (ui.kind === "invalid") {
    return { kind: "invalid", message: `spec: ${ui.message}` };
  }
  const unbound = unboundStatePaths(ui.value.$ui.spec, { queries, values });
  if (unbound.length > 0) {
    return {
      kind: "invalid",
      message: `spec: ${unbound.join(", ")} name no query or value of this page.`,
    };
  }
  return { kind: "valid", definition: { title, queries, values, spec: ui.value.$ui.spec } };
}

/** What the queries' declarations and the values break, named by where it sits, or null. */
function pageProblem(
  queries: Record<string, PageQuery>,
  values: Record<string, PageValue>,
): string | null {
  for (const [name, query] of Object.entries(queries)) {
    const counted = countColumns(query.columns, 1);
    if (counted.depth > PAGE_LIMITS.nestedRows) {
      return `queries.${name}.columns: Rows nest at most ${PAGE_LIMITS.nestedRows} deep.`;
    }
    if (counted.columns > PAGE_LIMITS.columns) {
      return `queries.${name}.columns: A query declares at most ${PAGE_LIMITS.columns} columns, counting those of nested rows.`;
    }
  }
  for (const [name, { query, field }] of Object.entries(values)) {
    const columns = Object.hasOwn(queries, query) ? queries[query].columns : null;
    if (!columns) {
      return `values.${name}.query: "${query}" is not a query of this page.`;
    }
    if (!Object.hasOwn(columns, field)) {
      return `values.${name}.field: Query ${query} has no "${field}" column. Columns: ${Object.keys(columns).join(", ")}.`;
    }
  }
  return null;
}

function countColumns(columns: PageColumns, depth: number): { columns: number; depth: number } {
  let count = 0;
  let deepest = depth;
  for (const column of Object.values(columns)) {
    count += 1;
    if (isRecord(column)) {
      const nested = countColumns(column.rows, depth + 1);
      count += nested.columns;
      deepest = Math.max(deepest, nested.depth);
    }
  }
  return { columns: count, depth: deepest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** State paths the spec reads, in props, conditions, and repeats, that name no query or value. */
function unboundStatePaths(
  spec: BackofficeUiSpec,
  { queries, values }: Pick<PageDefinition, "queries" | "values">,
): string[] {
  const unbound = new Set<string>();
  const check = (path: string) => {
    const [, root, name] = path.split("/");
    const known =
      (root === "data" && name !== undefined && Object.hasOwn(queries, name)) ||
      (root === "values" && name !== undefined && Object.hasOwn(values, name));
    if (!known) {
      unbound.add(path);
    }
  };
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (typeof value.$state === "string") {
      check(value.$state);
    }
    Object.values(value).forEach(visit);
  };
  for (const element of Object.values(spec.elements)) {
    visit(element.props);
    visit(element.visible);
    if (typeof element.repeat?.statePath === "string") {
      check(element.repeat.statePath);
    }
  }
  return [...unbound];
}
