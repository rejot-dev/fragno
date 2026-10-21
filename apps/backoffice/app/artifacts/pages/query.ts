import {
  add,
  and,
  avg,
  caseWhen,
  coalesce,
  concat,
  count,
  divide,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  length,
  like,
  lower,
  lt,
  lte,
  max,
  min,
  multiply,
  not,
  or,
  subtract,
  sum,
  toArray,
  upper,
  type InitialQueryBuilder,
} from "@tanstack/react-db";

import { intervalStarts } from "@/backoffice-ui/components/intervals";
import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";

import type {
  PageExpression,
  PageLiteral,
  PageQuery,
  PageQueryAggregate,
  PageQueryFunction,
  PageQuerySource,
  PageValue,
} from "./definition";

// The file was validated against these functions' arities, so they are called untyped.
type Operator = (...args: unknown[]) => unknown;

const FUNCTIONS = {
  eq,
  gt,
  gte,
  lt,
  lte,
  and,
  or,
  not,
  isNull,
  inArray,
  like,
  ilike,
  coalesce,
  caseWhen,
  concat,
  upper,
  lower,
  length,
  add,
  subtract,
  multiply,
  divide,
} as unknown as Record<PageQueryFunction, Operator>;

const AGGREGATES = { count, sum, avg, min, max } as unknown as Record<PageQueryAggregate, Operator>;

/** TanStack's refs by alias; aliases and fields come from the validated file, not from types. */
type Refs = Record<string, unknown>;

/**
 * Resolves an alias to its refs. A nested query reads its own aliases first, then those of the
 * rows around it, which is how `many` correlates with the selecting row.
 */
type Scope = (alias: string) => unknown;

/** The builder surface a page query uses, without TanStack's per-alias result typing. */
type DynamicQuery = {
  join(
    source: Record<string, unknown>,
    on: (refs: Refs) => unknown,
    type: "inner" | "left",
  ): DynamicQuery;
  where(callback: (refs: Refs) => unknown): DynamicQuery;
  groupBy(callback: (refs: Refs) => unknown): DynamicQuery;
  having(callback: (refs: Refs) => unknown): DynamicQuery;
  select(callback: (refs: Refs) => Record<string, unknown>): DynamicQuery;
  orderBy(callback: (refs: Refs) => unknown, direction: "asc" | "desc"): DynamicQuery;
  limit(count: number): DynamicQuery;
};

type DynamicBuilder = {
  from(source: Record<string, unknown>): DynamicQuery;
  unionAll(...branches: DynamicQuery[]): DynamicQuery;
};

/** Builds the TanStack DB live query a page query describes, with times relative to `now`. */
export function pageQuery(
  builder: InitialQueryBuilder,
  collections: AutomationCollections,
  query: PageQuery,
  now: number,
) {
  const built = buildQuery(builder as unknown as DynamicBuilder, collections, query, now, () => {
    throw new Error("A validated query reads only its own aliases.");
  });
  return built as unknown as ReturnType<InitialQueryBuilder["from"]>;
}

function buildQuery(
  builder: DynamicBuilder,
  collections: AutomationCollections,
  query: PageQuery,
  now: number,
  outer: Scope,
): DynamicQuery {
  if (query.kind === "union") {
    return builder.unionAll(
      ...query.branches.map((branch) => buildQuery(builder, collections, branch, now, outer)),
    );
  }
  const aliases = new Set([query.from.alias, ...query.joins.map(({ source }) => source.alias)]);
  const scope =
    (refs: Refs): Scope =>
    (alias) =>
      aliases.has(alias) ? refs[alias] : outer(alias);
  const compile = (refs: Refs) => (expression: PageExpression) =>
    compileExpression(expression, scope(refs), now);
  // Sources do not read the rows around them; the validator keeps their aliases to themselves.
  const source = ({ alias, ...read }: PageQuerySource) => ({
    [alias]:
      "collection" in read
        ? collections[read.collection]
        : buildQuery(builder, collections, read.query, now, outer),
  });

  let built = builder.from(source(query.from));
  for (const join of query.joins) {
    built = built.join(
      source(join.source),
      (refs) => eq(...(join.on.map(compile(refs)) as [never, never])),
      join.type,
    );
  }
  for (const where of query.where) {
    built = built.where((refs) => compile(refs)(where));
  }
  if (query.groupBy.length > 0) {
    built = built.groupBy((refs) => query.groupBy.map(compile(refs)));
  }
  for (const having of query.having) {
    built = built.having((refs) => compile(refs)(having));
  }
  const { select } = query;
  if (select) {
    built = built.select((refs) =>
      Object.fromEntries(
        Object.entries(select).map(([name, selection]) => [
          name,
          "many" in selection
            ? toArray(buildQuery(builder, collections, selection.many, now, scope(refs)) as never)
            : compile(refs)(selection),
        ]),
      ),
    );
  }
  for (const { expression, direction } of query.orderBy) {
    built = built.orderBy((refs) => compile(refs)(expression), direction);
  }
  if (query.limit !== null) {
    built = built.limit(query.limit);
  }
  return built;
}

function compileExpression(expression: PageExpression, scope: Scope, now: number): unknown {
  const compile = (inner: PageExpression) => compileExpression(inner, scope, now);
  if ("ref" in expression) {
    const [alias, ...path] = expression.ref;
    return path.reduce<unknown>(
      (ref, segment) => (ref as Record<string, unknown>)[segment],
      scope(alias),
    );
  }
  if ("value" in expression) {
    return expression.value;
  }
  if ("now" in expression) {
    return new Date(now + expression.now);
  }
  if ("fn" in expression) {
    return FUNCTIONS[expression.fn](...expression.args.map(compile));
  }
  if ("aggregate" in expression) {
    return AGGREGATES[expression.aggregate](compile(expression.arg));
  }
  // TanStack has no date truncation, so a bucket is the start of the newest interval it reached.
  // The oldest interval starts before `since`, so its condition is `since` itself: earlier times
  // reach no condition and have no bucket.
  const time = compile(expression.bucket);
  const starts = intervalStarts(now, expression).map((start) => new Date(start));
  const since = new Date(now + expression.since);
  return caseWhen(
    ...([...starts]
      .reverse()
      .flatMap((start, index, newestFirst) => [
        gte(time as never, index === newestFirst.length - 1 ? since : start),
        start,
      ]) as [never, never]),
  );
}

/** A value as the interface reads it: JSON, with times as ISO 8601 strings. */
export type PageData = PageLiteral | PageData[] | { [field: string]: PageData };

/**
 * Rows keep their types, nested rows included; components check the props they are bound to as
 * they render. TanStack's `$`-prefixed virtual fields describe sync state, not data.
 */
export function pageRows(rows: readonly object[]): PageData[] {
  return rows.map(pageData);
}

function pageData(value: unknown): PageData {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(pageData);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([field]) => !field.startsWith("$"))
        .map(([field, item]) => [field, pageData(item)]),
    );
  }
  return value as PageLiteral;
}

/** A value's field of its query's first row, or its stated value when the query has no rows. */
export function pageValue({ field, whenEmpty }: PageValue, rows: readonly PageData[]): PageData {
  const [first] = rows;
  return first === undefined ? whenEmpty : ((first as Record<string, PageData>)[field] ?? null);
}
