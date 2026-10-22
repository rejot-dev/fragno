import { z } from "zod";

import type { BackofficeUiSpec } from "../catalog";
import { INTERVAL_LIMITS, mostIntervals } from "../components/intervals";
import { parseBackofficeUiResult } from "../result";
import { pageQueriesError } from "./query";

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

/** How a field's value reads in a query, where references hold the referenced id. */
export type PageFieldType = "string" | "number" | "bigint" | "boolean" | "time" | "json" | "binary";

export type PageField = {
  name: string;
  type: PageFieldType;
  nullable: boolean;
};

/**
 * The fields of each collection a page can read, by the collection's name. The host decides which
 * collections exist; pages read only these.
 */
export type PageCollectionFields = Readonly<Record<string, readonly PageField[]>>;

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
  | { kind: "ref"; path: [alias: string, field: string, ...nested: string[]] }
  | { kind: "value"; value: PageLiteral | PageLiteral[] }
  | { kind: "now"; offset: number }
  | { kind: "fn"; name: PageQueryFunction; args: PageExpression[] }
  | { kind: "aggregate"; name: PageQueryAggregate; arg: PageExpression }
  | { kind: "bucket"; time: PageExpression; every: number; since: number };

/** A selected field: an expression, or the rows of a query correlated with the selecting row. */
export type PageSelection = PageExpression | { kind: "toArray"; query: PageQuery };

/** What a query reads: one of the host's collections, or another query's rows. */
export type PageQuerySource =
  | { kind: "collection"; alias: string; collection: string }
  | { kind: "query"; alias: string; query: PageQuery };

/**
 * A live query in TanStack DB's shape; every clause applies in the order TanStack applies it. A
 * union's branches select the same fields.
 */
export type PageQuery =
  | {
      kind: "select";
      from: PageQuerySource;
      joins: { type: "inner" | "left"; source: PageQuerySource; on: PageExpression }[];
      where: PageExpression[];
      groupBy: PageExpression[];
      having: PageExpression[];
      select: Record<string, PageSelection> | null;
      orderBy: { expression: PageExpression; direction: "asc" | "desc" }[];
      limit: number | null;
    }
  | { kind: "union"; branches: PageQuery[] };

type PageSelectQuery = Extract<PageQuery, { kind: "select" }>;

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
export const PAGE_DEFINITION_VERSION = 3;

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

/** An expression's shape; how deep expressions nest is checked over the parsed queries. */
const expressionSchema: z.ZodType<PageExpression> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("ref"),
      path: z.tuple([z.string(), z.string()], z.string()),
    }),
    z.strictObject({
      kind: z.literal("value"),
      value: z.union([
        literalSchema,
        z
          .array(literalSchema)
          .max(PAGE_LIMITS.listItems, `Lists hold at most ${PAGE_LIMITS.listItems} items.`),
      ]),
    }),
    z.strictObject({
      kind: z.literal("now"),
      offset: z.number({ error: "Expected an offset in milliseconds." }),
    }),
    z
      .strictObject({
        kind: z.literal("fn"),
        name: z.enum(Object.keys(PAGE_QUERY_FUNCTIONS) as [PageQueryFunction], {
          error: `Use one of: ${Object.keys(PAGE_QUERY_FUNCTIONS).join(", ")}.`,
        }),
        args: z.array(expressionSchema),
      })
      .superRefine(({ name, args }, context) => {
        const [minimum, maximum] = PAGE_QUERY_FUNCTIONS[name].arity;
        if (args.length < minimum || args.length > maximum) {
          context.addIssue({
            code: "custom",
            path: ["args"],
            message: `${name} takes ${minimum === maximum ? minimum : `${minimum} or more`} arguments.`,
          });
        }
      }),
    z.strictObject({
      kind: z.literal("aggregate"),
      name: z.enum(PAGE_QUERY_AGGREGATES, {
        error: `Use one of: ${PAGE_QUERY_AGGREGATES.join(", ")}.`,
      }),
      arg: expressionSchema,
    }),
    z
      .strictObject({
        kind: z.literal("bucket"),
        time: expressionSchema,
        every: z
          .int()
          .min(
            PAGE_LIMITS.minimumBucketMs,
            "Expected a whole number of milliseconds, at least one minute.",
          ),
        since: z.number().negative("Expected a negative offset from now in milliseconds."),
      })
      .refine(
        (bucket) => mostIntervals(bucket) <= PAGE_LIMITS.buckets,
        `A bucketed window has at most ${PAGE_LIMITS.buckets} buckets, counting the one now falls in.`,
      ),
  ]),
);

const limitMessage = `Expected null or a whole number 1-${PAGE_LIMITS.rowsPerQuery}.`;

const queryPartsMessage = `A query is made of at most ${PAGE_LIMITS.queryParts} queries, counting subqueries, toArray, and union branches.`;

/** A query's shape; the parts a query is made of are counted over the parsed queries. */
const querySchema: z.ZodType<PageQuery> = z.lazy(() => {
  const expression = expressionSchema;
  const source = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("collection"), alias: nameSchema, collection: z.string() }),
    z.strictObject({ kind: z.literal("query"), alias: nameSchema, query: querySchema }),
  ]);
  return z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("select"),
      from: source,
      joins: z.array(z.strictObject({ type: z.enum(["inner", "left"]), source, on: expression })),
      where: z.array(expression),
      groupBy: z.array(expression),
      having: z.array(expression),
      select: namedSchema(
        z.union([z.strictObject({ kind: z.literal("toArray"), query: querySchema }), expression]),
        64,
      ).nullable(),
      orderBy: z.array(z.strictObject({ expression, direction: z.enum(["asc", "desc"]) })),
      limit: z
        .int({ error: limitMessage })
        .min(1, limitMessage)
        .max(PAGE_LIMITS.rowsPerQuery, limitMessage)
        .nullable(),
    }),
    z.strictObject({
      kind: z.literal("union"),
      branches: z
        .array(querySchema)
        .min(2, `A union has 2-${PAGE_LIMITS.unionBranches} branches.`)
        .max(PAGE_LIMITS.unionBranches, `A union has 2-${PAGE_LIMITS.unionBranches} branches.`),
    }),
  ]);
});

/**
 * How deep a definition's queries may nest as JSON: each query part adds at most four levels, as
 * a join's source does, and each expression level two, as a function's arguments do. Deeper JSON
 * breaks a limit, so it fails before parsing walks it and exhausts the stack.
 */
const QUERIES_JSON_DEPTH = 4 * PAGE_LIMITS.queryParts + 2 * PAGE_LIMITS.expressionDepth + 8;

function jsonDepthExceeds(value: unknown, limit: number): boolean {
  const pending: [unknown, number][] = [[value, 0]];
  while (pending.length > 0) {
    const [item, depth] = pending.pop()!;
    if (item === null || typeof item !== "object") {
      continue;
    }
    if (depth > limit) {
      return true;
    }
    for (const child of Object.values(item)) {
      pending.push([child, depth + 1]);
    }
  }
  return false;
}

/** A definition's shape; which aliases and fields its queries read is checked once it parses. */
const pageFileSchema = z.strictObject({
  version: z.literal(PAGE_DEFINITION_VERSION),
  queries: namedSchema(querySchema, PAGE_LIMITS.queries),
  values: namedSchema(
    z.strictObject({ query: z.string(), field: z.string(), whenEmpty: literalSchema }),
    PAGE_LIMITS.values,
  ),
  spec: z.unknown(),
});

/** Validates what `page.define` returned, or what a cached build holds, against the host's collections. */
export function parsePageDefinition(
  json: unknown,
  collections: PageCollectionFields,
): PageParseResult {
  if (isRecord(json) && jsonDepthExceeds(json.queries, QUERIES_JSON_DEPTH)) {
    return {
      kind: "invalid",
      message: `queries: Queries nest deeper than a page allows: ${PAGE_LIMITS.queryParts} parts to a query, and expressions ${PAGE_LIMITS.expressionDepth} deep.`,
    };
  }
  const file = pageFileSchema.safeParse(json);
  if (!file.success) {
    const [issue] = file.error.issues;
    const path = issue.path.map(String).join(".");
    return { kind: "invalid", message: path ? `${path}: ${issue.message}` : issue.message };
  }
  const { queries, values, spec } = file.data;
  try {
    checkPage(queries, values, collections);
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
  const uncompiled = pageQueriesError(queries, collections);
  if (uncompiled !== null) {
    return { kind: "invalid", message: uncompiled };
  }
  const unbound = unboundStatePaths(ui.value.$ui.spec, { queries, values });
  if (unbound.length > 0) {
    return {
      kind: "invalid",
      message: `spec: ${unbound.join(", ")} name no query or value of this page.`,
    };
  }
  return { kind: "valid", definition: { queries, values, spec: ui.value.$ui.spec } };
}

/** A problem in a page definition, named by where it sits, such as `queries.q0.where.0: …`. */
class PageDefinitionError extends Error {}

function fail(path: string, message: string): never {
  throw new PageDefinitionError(`${path}: ${message}`);
}

/** A field of a query's rows; JSON fields read nested values by property. */
type QueryField = { name: string; json: boolean };

/** What each alias an expression may read names, and the fields it carries. */
type Sources = ReadonlyMap<string, { label: string; fields: QueryField[] }>;

/**
 * What checking one bound query tracks: the collections it may read, and the parts it is made of,
 * so nesting cannot multiply the work a page asks for.
 */
type QueryBudget = { collections: PageCollectionFields; parts: number };

/** Checks what each query reads and that each value names a field of its query. */
function checkPage(
  queries: Record<string, PageQuery>,
  values: Record<string, PageValue>,
  collections: PageCollectionFields,
) {
  const fields = new Map(
    Object.entries(queries).map(([name, query]) => [
      name,
      checkQuery(query, `queries.${name}`, new Map(), { collections, parts: 0 }).map(
        ({ name }) => name,
      ),
    ]),
  );
  for (const [name, { query, field }] of Object.entries(values)) {
    const queryFields = fields.get(query);
    if (!queryFields) {
      fail(`values.${name}.query`, `"${query}" is not a query of this page.`);
    }
    if (!queryFields.includes(field)) {
      fail(
        `values.${name}.field`,
        `Query ${query} has no "${field}" field. Fields: ${queryFields.join(", ")}.`,
      );
    }
  }
}

/**
 * Which clause an expression sits in decides whether aggregates may appear in it; depth counts
 * the expressions around it.
 */
type ExpressionContext = {
  sources: Sources;
  aggregates: "allowed" | "forbidden";
  depth: number;
};

/**
 * Checks a query and returns the fields its rows carry. `outer` holds the aliases of the rows a
 * toArray query is correlated with; a query's own aliases may not shadow them.
 */
function checkQuery(
  query: PageQuery,
  path: string,
  outer: Sources,
  budget: QueryBudget,
): QueryField[] {
  budget.parts += 1;
  if (budget.parts > PAGE_LIMITS.queryParts) {
    fail(path, queryPartsMessage);
  }
  return query.kind === "union"
    ? checkUnion(query.branches, path, outer, budget)
    : checkSelectQuery(query, path, outer, budget);
}

function checkUnion(
  branches: PageQuery[],
  path: string,
  outer: Sources,
  budget: QueryBudget,
): QueryField[] {
  const [first, ...rest] = branches.map((branch, index) =>
    checkQuery(branch, `${path}.branches.${index}`, outer, budget),
  );
  const names = (fields: QueryField[]) => fields.map(({ name }) => name).sort();
  for (const [index, fields] of rest.entries()) {
    if (names(fields).join() !== names(first).join()) {
      fail(
        `${path}.branches.${index + 1}`,
        `A union's branches select the same fields: ${names(first).join(", ")}; this branch selects ${names(fields).join(", ")}.`,
      );
    }
  }
  return first.map(({ name, json }) => ({
    name,
    json: json && rest.every((fields) => fields.some((f) => f.name === name && f.json)),
  }));
}

function checkSelectQuery(
  query: PageSelectQuery,
  path: string,
  outer: Sources,
  budget: QueryBudget,
): QueryField[] {
  const sources = new Map(outer);
  addSource(query.from, `${path}.from`, sources, budget);
  for (const [index, join] of query.joins.entries()) {
    addSource(join.source, `${path}.joins.${index}.source`, sources, budget);
    // TanStack checks that each side of the condition reads one side of the join.
    checkExpression(join.on, `${path}.joins.${index}.on`, {
      sources,
      aggregates: "forbidden",
      depth: 0,
    });
  }

  const plain: ExpressionContext = { sources, aggregates: "forbidden", depth: 0 };
  const aggregated: ExpressionContext = { sources, aggregates: "allowed", depth: 0 };
  for (const [key, context] of [
    ["where", plain],
    ["groupBy", plain],
    ["having", aggregated],
  ] as const) {
    for (const [index, expression] of query[key].entries()) {
      checkExpression(expression, `${path}.${key}.${index}`, context);
    }
  }
  for (const [index, { expression }] of query.orderBy.entries()) {
    checkExpression(expression, `${path}.orderBy.${index}.expression`, aggregated);
  }
  const selected =
    query.select &&
    Object.entries(query.select).map(([name, selection]) => {
      const selectionPath = `${path}.select.${name}`;
      if (selection.kind === "toArray") {
        checkQuery(selection.query, `${selectionPath}.query`, sources, budget);
        return { name, json: false };
      }
      checkExpression(selection, selectionPath, aggregated);
      return { name, json: readsJson(selection, sources) };
    });

  // TanStack nests joined rows by alias and labels grouped rows by internal keys without a selection.
  if (selected === null && query.joins.length > 0) {
    fail(`${path}.select`, "A query with joins selects the fields it shows.");
  }
  const grouped = query.groupBy.length > 0 || query.having.length > 0;
  if (selected === null && grouped) {
    fail(`${path}.select`, "A grouped query selects its group fields and aggregates.");
  }
  return selected ?? sources.get(query.from.alias)!.fields;
}

/** Whether a selected expression carries a JSON value, whose nested fields later queries read. */
function readsJson(expression: PageExpression, sources: Sources): boolean {
  if (expression.kind !== "ref") {
    return false;
  }
  const [alias, field, ...nested] = expression.path;
  return (
    nested.length > 0 ||
    (sources.get(alias)?.fields.some(({ name, json }) => name === field && json) ?? false)
  );
}

function addSource(
  source: PageQuerySource,
  path: string,
  sources: Map<string, { label: string; fields: QueryField[] }>,
  budget: QueryBudget,
) {
  const { alias } = source;
  if (sources.has(alias)) {
    fail(`${path}.alias`, `"${alias}" already names a source of this query or the rows around it.`);
  }
  if (source.kind === "query") {
    // A source's rows do not depend on the row around it, so it reads none of the outer aliases.
    const fields = checkQuery(source.query, `${path}.query`, new Map(), budget);
    sources.set(alias, { label: `The query under ${alias}`, fields });
    return;
  }
  const collection = budget.collections[source.collection];
  if (!collection) {
    fail(
      `${path}.collection`,
      `"${source.collection}" is not a page collection. Use one of: ${Object.keys(budget.collections).join(", ")}.`,
    );
  }
  const fields = collection.map(({ name, type }) => ({ name, json: type === "json" }));
  sources.set(alias, { label: source.collection, fields });
}

function checkExpression(expression: PageExpression, path: string, context: ExpressionContext) {
  if (context.depth > PAGE_LIMITS.expressionDepth) {
    fail(path, `Expressions nest at most ${PAGE_LIMITS.expressionDepth} deep.`);
  }
  const inner = { ...context, depth: context.depth + 1 };
  switch (expression.kind) {
    case "ref": {
      const [alias, field, ...nested] = expression.path;
      const source = context.sources.get(alias);
      if (!source) {
        fail(
          `${path}.path`,
          `"${alias}" is not a source of this query or of the rows a toArray(...) query is nested in: ${[...context.sources.keys()].join(", ")}.`,
        );
      }
      const column = source.fields.find(({ name }) => name === field);
      if (!column) {
        fail(
          `${path}.path`,
          `${source.label} has no "${field}" field. Fields: ${source.fields.map(({ name }) => name).join(", ")}.`,
        );
      }
      if (nested.length > 0 && !column.json) {
        fail(`${path}.path`, `${alias}.${field} is not JSON, so it has no nested fields.`);
      }
      return;
    }
    case "fn":
      for (const [index, arg] of expression.args.entries()) {
        checkExpression(arg, `${path}.args.${index}`, inner);
      }
      return;
    case "aggregate":
      if (context.aggregates === "forbidden") {
        fail(path, "Aggregates belong in select, having, or orderBy, outside other aggregates.");
      }
      checkExpression(expression.arg, `${path}.arg`, { ...inner, aggregates: "forbidden" });
      return;
    case "bucket":
      checkExpression(expression.time, `${path}.time`, inner);
      return;
    case "value":
    case "now":
      return;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
