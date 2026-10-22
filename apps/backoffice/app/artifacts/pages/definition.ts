import type { AnyColumn, AnyTable } from "@fragno-dev/db/schema";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import type { BackofficeUiSpec } from "@/backoffice-ui/catalog";
import { INTERVAL_LIMITS, mostIntervals } from "@/backoffice-ui/components/intervals";
import { parseBackofficeUiResult } from "@/backoffice-ui/result";
import { automationFragmentSchema } from "@/fragno/automation/schema";
import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";

import { pageQueriesError } from "./query";

/** The synchronized collections a page query can read from, by the table each one mirrors. */
export const PAGE_COLLECTIONS = {
  projects: automationFragmentSchema.tables.project,
  routes: automationFragmentSchema.tables.automation_route,
  routeScheduleStates: automationFragmentSchema.tables.automation_route_schedule_state,
  routeDispatches: automationFragmentSchema.tables.automation_route_dispatch,
  events: automationFragmentSchema.tables.automation_event,
  eventSources: automationFragmentSchema.tables.automation_event_source,
  eventDefinitions: automationFragmentSchema.tables.automation_event_definition,
  kvStore: automationFragmentSchema.tables.kv_store,
  workflowInstances: workflowsSchema.tables.workflow_instance,
  workflowSteps: workflowsSchema.tables.workflow_step,
  workflowEvents: workflowsSchema.tables.workflow_event,
} satisfies Partial<Record<keyof AutomationCollections, AnyTable>>;

export type PageCollection = keyof typeof PAGE_COLLECTIONS;

export const PAGE_LIMITS = {
  queries: 16,
  values: 32,
  /** Every query a bound query is made of: itself, its subqueries, nested rows, and branches. */
  queryParts: 16,
  unionBranches: 8,
  rowsPerQuery: 100,
  buckets: INTERVAL_LIMITS.count,
  minimumBucketMs: INTERVAL_LIMITS.minimumMs,
  expressionDepth: 32,
  listItems: 100,
} as const;

/** How a column's synchronized value reads in a query, where references hold the referenced id. */
export type PageFieldType = "string" | "number" | "bigint" | "boolean" | "time" | "json" | "binary";

export type PageField = {
  name: string;
  type: PageFieldType;
  nullable: boolean;
};

function fieldType(column: AnyColumn): PageFieldType {
  if (column.role === "reference" || column.type.startsWith("varchar(")) {
    return "string";
  }
  switch (column.type) {
    case "string":
    case "text":
      return "string";
    case "integer":
    case "decimal":
      return "number";
    case "bigint":
      return "bigint";
    case "bool":
      return "boolean";
    case "date":
    case "timestamp":
      return "time";
    case "json":
      return "json";
    case "binary":
      return "binary";
    default:
      throw new Error(`Unknown column type ${column.type}.`);
  }
}

/** The fields a collection's rows carry; underscore columns are the database's bookkeeping. */
export function pageFields(collection: PageCollection): PageField[] {
  return Object.entries(PAGE_COLLECTIONS[collection].columns as Record<string, AnyColumn>)
    .filter(([name]) => !name.startsWith("_"))
    .map(([name, column]) => ({ name, type: fieldType(column), nullable: column.isNullable }));
}

export const PAGE_QUERY_FUNCTIONS = {
  eq: { arity: [2, 2] },
  gt: { arity: [2, 2] },
  gte: { arity: [2, 2] },
  lt: { arity: [2, 2] },
  lte: { arity: [2, 2] },
  and: { arity: [2, Infinity] },
  or: { arity: [2, Infinity] },
  not: { arity: [1, 1] },
  isNull: { arity: [1, 1] },
  inArray: { arity: [2, 2] },
  like: { arity: [2, 2] },
  ilike: { arity: [2, 2] },
  coalesce: { arity: [1, Infinity] },
  caseWhen: { arity: [2, Infinity] },
  concat: { arity: [1, Infinity] },
  upper: { arity: [1, 1] },
  lower: { arity: [1, 1] },
  length: { arity: [1, 1] },
  add: { arity: [2, 2] },
  subtract: { arity: [2, 2] },
  multiply: { arity: [2, 2] },
  divide: { arity: [2, 2] },
} as const satisfies Record<string, { arity: readonly [number, number] }>;

export type PageQueryFunction = keyof typeof PAGE_QUERY_FUNCTIONS;

export const PAGE_QUERY_AGGREGATES = ["count", "sum", "avg", "min", "max"] as const;

export type PageQueryAggregate = (typeof PAGE_QUERY_AGGREGATES)[number];

export type PageLiteral = string | number | boolean | null;

/**
 * A query expression. Times are relative to the moment the page renders: `now` is an offset
 * in milliseconds, and a bucket labels each row with the start of its `every`-long interval since
 * `since`, or null before it.
 */
export type PageExpression =
  | { ref: [alias: string, field: string, ...path: string[]] }
  | { value: PageLiteral | PageLiteral[] }
  | { now: number }
  | { fn: PageQueryFunction; args: PageExpression[] }
  | { aggregate: PageQueryAggregate; arg: PageExpression }
  | { bucket: PageExpression; every: number; since: number };

/** A selected field: an expression, or the rows of a query correlated with the selecting row. */
export type PageSelection = PageExpression | { many: PageQuery };

type PageSelectQuery = Extract<PageQuery, { kind: "select" }>;

/** What a query reads: a synchronized collection, or another query's rows. */
export type PageQuerySource =
  | { alias: string; collection: PageCollection }
  | { alias: string; query: PageQuery };

/**
 * A live query in TanStack DB's shape; every clause applies in the order TanStack applies it. A
 * union's branches select the same fields.
 */
export type PageQuery =
  | {
      kind: "select";
      from: PageQuerySource;
      joins: {
        type: "inner" | "left";
        source: PageQuerySource;
        on: [PageExpression, PageExpression];
      }[];
      where: PageExpression[];
      groupBy: PageExpression[];
      having: PageExpression[];
      select: Record<string, PageSelection> | null;
      orderBy: { expression: PageExpression; direction: "asc" | "desc" }[];
      limit: number | null;
    }
  | { kind: "union"; branches: PageQuery[] };

/** One field of a query's first row, such as a count for a metric. */
export type PageValue = { query: string; field: string; whenEmpty: PageLiteral };

/** A built page: named live queries and values, and the interface bound to them. */
export type PageDefinition = {
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
export const PAGE_DEFINITION_VERSION = 2;

/** Validates what `page.define` returned, or what a cached build holds. */
export function parsePageDefinition(json: unknown): PageParseResult {
  let page: Omit<PageDefinition, "spec">;
  let spec: unknown;
  try {
    const file = readObject(json, "", ["version", "queries", "values", "spec"]);
    if (file.version !== PAGE_DEFINITION_VERSION) {
      fail("version", `Expected ${PAGE_DEFINITION_VERSION}.`);
    }
    page = readPage(file.queries, file.values);
    spec = file.spec;
  } catch (error) {
    if (error instanceof PageDefinitionError) {
      return { kind: "invalid", message: error.message };
    }
    throw error;
  }

  const ui = parseBackofficeUiResult({ $ui: { version: 1, state: {}, spec } });
  if (ui.kind === "ordinary") {
    throw new Error("A $ui envelope always parses as generated UI.");
  }
  if (ui.kind === "invalid") {
    return { kind: "invalid", message: `spec: ${ui.message}` };
  }
  const uncompiled = pageQueriesError(page.queries);
  if (uncompiled !== null) {
    return { kind: "invalid", message: uncompiled };
  }
  const unbound = unboundStatePaths(ui.value.$ui.spec, page);
  if (unbound.length > 0) {
    return {
      kind: "invalid",
      message: `spec: ${unbound.join(", ")} name no query or value of this page.`,
    };
  }
  return { kind: "valid", definition: { ...page, spec: ui.value.$ui.spec } };
}

/** A problem in a page definition, named by where it sits, such as `queries.q0.where.0: …`. */
class PageDefinitionError extends Error {}

function fail(path: string, message: string): never {
  throw new PageDefinitionError(path ? `${path}: ${message}` : message);
}

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

function readObject(value: unknown, path: string, keys: readonly string[]) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "Expected an object.");
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !keys.includes(key));
  if (extra.length > 0) {
    fail(path, `Remove ${extra.join(", ")}; this object has only ${keys.join(", ")}.`);
  }
  const missing = keys.filter((key) => !Object.hasOwn(record, key));
  if (missing.length > 0) {
    fail(path, `Add ${missing.join(", ")}.`);
  }
  return record;
}

function readRecord(value: unknown, path: string, limit: number) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "Expected an object.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > limit) {
    fail(path, `At most ${limit} entries.`);
  }
  for (const [name] of entries) {
    if (!NAME_PATTERN.test(name)) {
      fail(path, `"${name}" must start with a letter and use letters, digits, and _.`);
    }
  }
  return entries;
}

function readArray(value: unknown, path: string) {
  if (!Array.isArray(value)) {
    fail(path, "Expected an array.");
  }
  return value as unknown[];
}

function readString(value: unknown, path: string) {
  if (typeof value !== "string") {
    fail(path, "Expected a string.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A field of a query's rows; JSON fields read nested values by property. */
type QueryField = { name: string; json: boolean };

/** What each alias an expression may read names, and the fields it carries. */
type Sources = ReadonlyMap<string, { label: string; fields: QueryField[] }>;

/** Counts the parts of one bound query, so nesting cannot multiply the work a page asks for. */
type QueryBudget = { parts: number };

function readPage(queries: unknown, values: unknown): Omit<PageDefinition, "spec"> {
  const parsedQueries = Object.fromEntries(
    readRecord(queries, "queries", PAGE_LIMITS.queries).map(([name, query]) => [
      name,
      readQuery(query, `queries.${name}`, new Map(), { parts: 0 }),
    ]),
  );
  const parsedValues = Object.fromEntries(
    readRecord(values, "values", PAGE_LIMITS.values).map(([name, value]) => {
      const path = `values.${name}`;
      const record = readObject(value, path, ["query", "field", "whenEmpty"]);
      const query = readString(record.query, `${path}.query`);
      const field = readString(record.field, `${path}.field`);
      const fields = Object.hasOwn(parsedQueries, query)
        ? parsedQueries[query].fields.map(({ name: fieldName }) => fieldName)
        : null;
      if (!fields) {
        fail(`${path}.query`, `"${query}" is not a query of this page.`);
      }
      if (!fields.includes(field)) {
        fail(
          `${path}.field`,
          `Query ${query} has no "${field}" field. Fields: ${fields.join(", ")}.`,
        );
      }
      const whenEmpty = readLiteral(record.whenEmpty, `${path}.whenEmpty`);
      return [name, { query, field, whenEmpty }];
    }),
  );
  return {
    queries: Object.fromEntries(
      Object.entries(parsedQueries).map(([name, { query }]) => [name, query]),
    ),
    values: parsedValues,
  };
}

/** Which clause an expression sits in decides whether aggregates may appear in it. */
type ExpressionContext = {
  sources: Sources;
  aggregates: "allowed" | "forbidden";
};

/**
 * Reads a query and the fields its rows carry. `outer` holds the aliases of the rows a nested
 * query is correlated with; a query's own aliases may not shadow them.
 */
function readQuery(
  value: unknown,
  path: string,
  outer: Sources,
  budget: QueryBudget,
): { query: PageQuery; fields: QueryField[] } {
  budget.parts += 1;
  if (budget.parts > PAGE_LIMITS.queryParts) {
    fail(
      path,
      `A query is made of at most ${PAGE_LIMITS.queryParts} queries, counting subqueries, many, and union branches.`,
    );
  }
  if (isRecord(value) && value.kind === "union") {
    return readUnion(value, path, outer, budget);
  }
  return readSelectQuery(value, path, outer, budget);
}

function readUnion(
  value: Record<string, unknown>,
  path: string,
  outer: Sources,
  budget: QueryBudget,
): { query: PageQuery; fields: QueryField[] } {
  const record = readObject(value, path, ["kind", "branches"]);
  const branches = readArray(record.branches, `${path}.branches`);
  if (branches.length < 2 || branches.length > PAGE_LIMITS.unionBranches) {
    fail(`${path}.branches`, `A union has 2-${PAGE_LIMITS.unionBranches} branches.`);
  }
  const read = branches.map((branch, index) =>
    readQuery(branch, `${path}.branches.${index}`, outer, budget),
  );
  const names = (fields: QueryField[]) => fields.map(({ name }) => name).sort();
  const [first, ...rest] = read;
  for (const [index, branch] of rest.entries()) {
    if (names(branch.fields).join() !== names(first.fields).join()) {
      fail(
        `${path}.branches.${index + 1}`,
        `A union's branches select the same fields: ${names(first.fields).join(", ")}; this branch selects ${names(branch.fields).join(", ")}.`,
      );
    }
  }
  return {
    query: { kind: "union", branches: read.map(({ query }) => query) },
    fields: first.fields.map(({ name, json }) => ({
      name,
      json: json && rest.every(({ fields }) => fields.some((f) => f.name === name && f.json)),
    })),
  };
}

function readSelectQuery(
  value: unknown,
  path: string,
  outer: Sources,
  budget: QueryBudget,
): { query: PageQuery; fields: QueryField[] } {
  const query = readObject(value, path, [
    "kind",
    "from",
    "joins",
    "where",
    "groupBy",
    "having",
    "select",
    "orderBy",
    "limit",
  ]);
  if (query.kind !== "select") {
    fail(`${path}.kind`, 'Expected "select" or "union".');
  }
  const sources = new Map(outer);
  const from = readSource(query.from, `${path}.from`, sources, budget);
  const joins = readArray(query.joins, `${path}.joins`).map(
    (join, index): PageSelectQuery["joins"][number] => {
      const joinPath = `${path}.joins.${index}`;
      const record = readObject(join, joinPath, ["type", "source", "on"]);
      const { type } = record;
      if (type !== "inner" && type !== "left") {
        fail(`${joinPath}.type`, 'Expected "inner" or "left".');
      }
      const source = readSource(record.source, `${joinPath}.source`, sources, budget);
      const on = readArray(record.on, `${joinPath}.on`);
      if (on.length !== 2) {
        fail(`${joinPath}.on`, "Expected the two fields a join matches.");
      }
      const context: ExpressionContext = { sources, aggregates: "forbidden" };
      const [left, right] = on.map((side, sideIndex) => {
        const expression = readExpression(side, `${joinPath}.on.${sideIndex}`, context, 0);
        if (!("ref" in expression)) {
          fail(`${joinPath}.on.${sideIndex}`, "A join matches fields, such as run.id.");
        }
        return expression;
      });
      return { type, source, on: [left, right] as [PageExpression, PageExpression] };
    },
  );

  const plain: ExpressionContext = { sources, aggregates: "forbidden" };
  const aggregated: ExpressionContext = { sources, aggregates: "allowed" };
  const expressions = (key: string, context: ExpressionContext) =>
    readArray(query[key], `${path}.${key}`).map((expression, index) =>
      readExpression(expression, `${path}.${key}.${index}`, context, 0),
    );
  const where = expressions("where", plain);
  const groupBy = expressions("groupBy", plain);
  const having = expressions("having", aggregated);
  const selected =
    query.select === null
      ? null
      : readRecord(query.select, `${path}.select`, 64).map(([name, selection]) => {
          const selectionPath = `${path}.select.${name}`;
          if (isRecord(selection) && Object.hasOwn(selection, "many")) {
            const record = readObject(selection, selectionPath, ["many"]);
            const nested = readQuery(record.many, `${selectionPath}.many`, sources, budget);
            return { name, selection: { many: nested.query }, json: false };
          }
          const expression = readExpression(selection, selectionPath, aggregated, 0);
          return { name, selection: expression, json: readsJson(expression, sources) };
        });
  const orderBy = readArray(query.orderBy, `${path}.orderBy`).map(
    (entry, index): PageSelectQuery["orderBy"][number] => {
      const entryPath = `${path}.orderBy.${index}`;
      const record = readObject(entry, entryPath, ["expression", "direction"]);
      const { direction } = record;
      if (direction !== "asc" && direction !== "desc") {
        fail(`${entryPath}.direction`, 'Expected "asc" or "desc".');
      }
      return {
        expression: readExpression(record.expression, `${entryPath}.expression`, aggregated, 0),
        direction,
      };
    },
  );

  const limit = query.limit;
  if (
    limit !== null &&
    (!Number.isInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > PAGE_LIMITS.rowsPerQuery)
  ) {
    fail(`${path}.limit`, `Expected null or a whole number 1-${PAGE_LIMITS.rowsPerQuery}.`);
  }
  // TanStack nests joined rows by alias and labels grouped rows by internal keys without a selection.
  if (selected === null && joins.length > 0) {
    fail(`${path}.select`, "A query with joins selects the fields it shows.");
  }
  const grouped =
    groupBy.length > 0 ||
    having.length > 0 ||
    (selected ?? []).some(
      ({ selection }) => !("many" in selection) && containsAggregate(selection),
    );
  if (selected === null && grouped) {
    fail(`${path}.select`, "A grouped query selects its group fields and aggregates.");
  }
  return {
    query: {
      kind: "select",
      from,
      joins,
      where,
      groupBy,
      having,
      select: selected
        ? Object.fromEntries(selected.map(({ name, selection }) => [name, selection]))
        : null,
      orderBy,
      limit: limit as number | null,
    },
    fields: selected
      ? selected.map(({ name, json }) => ({ name, json }))
      : sources.get(from.alias)!.fields,
  };
}

/** Whether a selected expression carries a JSON value, whose nested fields later queries read. */
function readsJson(expression: PageExpression, sources: Sources): boolean {
  if (!("ref" in expression)) {
    return false;
  }
  const [alias, field, ...nested] = expression.ref;
  return (
    nested.length > 0 ||
    (sources.get(alias)?.fields.some(({ name, json }) => name === field && json) ?? false)
  );
}

function readSource(
  value: unknown,
  path: string,
  sources: Map<string, { label: string; fields: QueryField[] }>,
  budget: QueryBudget,
): PageQuerySource {
  const subquery = isRecord(value) && Object.hasOwn(value, "query");
  const record = readObject(value, path, ["alias", subquery ? "query" : "collection"]);
  const alias = readString(record.alias, `${path}.alias`);
  if (!NAME_PATTERN.test(alias)) {
    fail(`${path}.alias`, "Start with a letter and use letters, digits, and _.");
  }
  if (sources.has(alias)) {
    fail(`${path}.alias`, `"${alias}" already names a source of this query or the rows around it.`);
  }
  if (subquery) {
    // A source's rows do not depend on the row around it, so it reads none of the outer aliases.
    const { query, fields } = readQuery(record.query, `${path}.query`, new Map(), budget);
    sources.set(alias, { label: `The query under ${alias}`, fields });
    return { alias, query };
  }
  const collection = readString(record.collection, `${path}.collection`);
  if (!Object.hasOwn(PAGE_COLLECTIONS, collection)) {
    fail(
      `${path}.collection`,
      `"${collection}" is not a page collection. Use one of: ${Object.keys(PAGE_COLLECTIONS).join(", ")}.`,
    );
  }
  const fields = pageFields(collection as PageCollection).map(({ name, type }) => ({
    name,
    json: type === "json",
  }));
  sources.set(alias, { label: collection, fields });
  return { alias, collection: collection as PageCollection };
}

function readLiteral(value: unknown, path: string): PageLiteral {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  return fail(path, "Expected a string, finite number, boolean, or null.");
}

function readExpression(
  value: unknown,
  path: string,
  context: ExpressionContext,
  depth: number,
): PageExpression {
  if (depth > PAGE_LIMITS.expressionDepth) {
    fail(path, `Expressions nest at most ${PAGE_LIMITS.expressionDepth} deep.`);
  }
  if (!isRecord(value)) {
    fail(path, "Expected an expression object.");
  }
  const kind = Object.keys(value).find((key) =>
    ["ref", "value", "now", "fn", "aggregate", "bucket", "many"].includes(key),
  );
  switch (kind) {
    case "ref": {
      const record = readObject(value, path, ["ref"]);
      const ref = readArray(record.ref, `${path}.ref`).map((segment, index) =>
        readString(segment, `${path}.ref.${index}`),
      );
      const [alias, field, ...nested] = ref;
      const source = alias === undefined ? undefined : context.sources.get(alias);
      if (!source || field === undefined) {
        fail(
          `${path}.ref`,
          `Expected [alias, field], where alias is a source of this query or of the rows a many(...) query is nested in: ${[...context.sources.keys()].join(", ")}.`,
        );
      }
      const column = source.fields.find(({ name }) => name === field);
      if (!column) {
        fail(
          `${path}.ref`,
          `${source.label} has no "${field}" field. Fields: ${source.fields.map(({ name }) => name).join(", ")}.`,
        );
      }
      if (nested.length > 0 && !column.json) {
        fail(`${path}.ref`, `${alias}.${field} is not JSON, so it has no nested fields.`);
      }
      return { ref: [alias, field, ...nested] };
    }
    case "value": {
      const record = readObject(value, path, ["value"]);
      if (Array.isArray(record.value)) {
        if (record.value.length > PAGE_LIMITS.listItems) {
          fail(`${path}.value`, `Lists hold at most ${PAGE_LIMITS.listItems} items.`);
        }
        return {
          value: record.value.map((item, index) => readLiteral(item, `${path}.value.${index}`)),
        };
      }
      return { value: readLiteral(record.value, `${path}.value`) };
    }
    case "now": {
      const record = readObject(value, path, ["now"]);
      if (typeof record.now !== "number" || !Number.isFinite(record.now)) {
        fail(`${path}.now`, "Expected an offset in milliseconds.");
      }
      return { now: record.now };
    }
    case "fn": {
      const record = readObject(value, path, ["fn", "args"]);
      const fn = readString(record.fn, `${path}.fn`);
      if (!Object.hasOwn(PAGE_QUERY_FUNCTIONS, fn)) {
        fail(
          `${path}.fn`,
          `"${fn}" is not a page function. Use one of: ${Object.keys(PAGE_QUERY_FUNCTIONS).join(", ")}.`,
        );
      }
      const {
        arity: [minimum, maximum],
      } = PAGE_QUERY_FUNCTIONS[fn as PageQueryFunction];
      const args = readArray(record.args, `${path}.args`);
      if (args.length < minimum || args.length > maximum) {
        fail(
          `${path}.args`,
          `${fn} takes ${minimum === maximum ? minimum : `${minimum} or more`} arguments.`,
        );
      }
      return {
        fn: fn as PageQueryFunction,
        args: args.map((arg, index) =>
          readExpression(arg, `${path}.args.${index}`, context, depth + 1),
        ),
      };
    }
    case "aggregate": {
      const record = readObject(value, path, ["aggregate", "arg"]);
      const aggregate = readString(record.aggregate, `${path}.aggregate`);
      if (!PAGE_QUERY_AGGREGATES.includes(aggregate as PageQueryAggregate)) {
        fail(`${path}.aggregate`, `Use one of: ${PAGE_QUERY_AGGREGATES.join(", ")}.`);
      }
      if (context.aggregates === "forbidden") {
        fail(path, "Aggregates belong in select, having, or orderBy, outside other aggregates.");
      }
      return {
        aggregate: aggregate as PageQueryAggregate,
        arg: readExpression(
          record.arg,
          `${path}.arg`,
          { ...context, aggregates: "forbidden" },
          depth + 1,
        ),
      };
    }
    case "bucket": {
      const record = readObject(value, path, ["bucket", "every", "since"]);
      const { every, since } = record;
      if (
        typeof every !== "number" ||
        !Number.isInteger(every) ||
        every < PAGE_LIMITS.minimumBucketMs
      ) {
        fail(`${path}.every`, "Expected a whole number of milliseconds, at least one minute.");
      }
      if (typeof since !== "number" || !Number.isFinite(since) || since >= 0) {
        fail(`${path}.since`, "Expected a negative offset from now in milliseconds.");
      }
      if (mostIntervals({ every, since }) > PAGE_LIMITS.buckets) {
        fail(
          path,
          `A bucketed window has at most ${PAGE_LIMITS.buckets} buckets, counting the one now falls in.`,
        );
      }
      return {
        bucket: readExpression(record.bucket, `${path}.bucket`, context, depth + 1),
        every,
        since,
      };
    }
    case "many":
      return fail(path, "many(...) is a whole select field, not part of an expression.");
    case undefined:
    default:
      return fail(path, "Expected one of ref, value, now, fn, aggregate, or bucket.");
  }
}

function containsAggregate(expression: PageExpression): boolean {
  if ("aggregate" in expression) {
    return true;
  }
  if ("fn" in expression) {
    return expression.args.some(containsAggregate);
  }
  if ("bucket" in expression) {
    return containsAggregate(expression.bucket);
  }
  return false;
}

/** State paths the spec reads, in props, conditions, and repeats, that name no query or value. */
function unboundStatePaths(
  spec: BackofficeUiSpec,
  { queries, values }: Omit<PageDefinition, "spec">,
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
