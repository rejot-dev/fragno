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
  upper,
  type InitialQueryBuilder,
} from "@tanstack/react-db";

import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";

import type {
  PageQueryAggregate,
  PageExpression,
  PageQueryFunction,
  PageQuery,
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

/** Builds the TanStack DB live query a page query describes, with times relative to `now`. */
export function pageQuery(
  builder: InitialQueryBuilder,
  collections: AutomationCollections,
  query: PageQuery,
  now: number,
) {
  const initial = builder.from({ [query.from.alias]: collections[query.from.collection] });
  let built = initial as unknown as DynamicQuery;
  const compile = (refs: Refs) => (expression: PageExpression) =>
    compileExpression(expression, refs, now);

  for (const join of query.joins) {
    built = built.join(
      { [join.source.alias]: collections[join.source.collection] },
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
        Object.entries(select).map(([name, expression]) => [name, compile(refs)(expression)]),
      ),
    );
  }
  for (const { expression, direction } of query.orderBy) {
    built = built.orderBy((refs) => compile(refs)(expression), direction);
  }
  if (query.limit !== null) {
    built = built.limit(query.limit);
  }
  return built as unknown as typeof initial;
}

function compileExpression(expression: PageExpression, refs: Refs, now: number): unknown {
  const compile = (inner: PageExpression) => compileExpression(inner, refs, now);
  if ("ref" in expression) {
    return expression.ref.reduce<unknown>(
      (ref, segment) => (ref as Record<string, unknown>)[segment],
      refs,
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
  const starts = bucketStarts(now, expression.since, expression.every);
  const since = new Date(now + expression.since);
  return caseWhen(
    ...(starts.flatMap((start, index) => [
      gte(time as never, index === starts.length - 1 ? since : start),
      start,
    ]) as [never, never]),
  );
}

/** Interval starts aligned to whole `every`s, newest first, from now back through `since`. */
function bucketStarts(now: number, since: number, every: number): Date[] {
  const first = Math.floor((now + since) / every) * every;
  const newest = Math.floor(now / every) * every;
  return Array.from(
    { length: (newest - first) / every + 1 },
    (_, index) => new Date(newest - index * every),
  );
}

/**
 * Generated UI shows text, so each value becomes the string a person reads. Nothing checks bound
 * props once the spec has been validated, so this is where rows are made safe to render.
 * TanStack's `$`-prefixed virtual fields describe sync state, not data.
 */
export function pageRows(rows: readonly Record<string, unknown>[]): Record<string, string>[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row)
        .filter(([field]) => !field.startsWith("$"))
        .map(([field, value]) => [field, displayValue(value)]),
    ),
  );
}

/** A value's field of its query's first row, or its stated text when the query has no rows. */
export function pageValueText(
  { field, whenEmpty }: PageValue,
  rows: readonly Record<string, string>[],
): string {
  const [first] = rows;
  return first ? (first[field] ?? "") : whenEmpty;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
