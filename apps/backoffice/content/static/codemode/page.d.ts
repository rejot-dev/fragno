/// <reference path="/static/codemode/page-schema.d.ts" />
// The page builder. page.define records live queries over the scope's collections, in TanStack
// DB's query style, and binds their results to a ui interface. Default-export it from a
// /workspace/**/<name>.page.js file; the system builds it when it opens. page-schema.d.ts declares
// the collections, their fields, and PageLimits.

declare const pageExpressionType: unique symbol;
declare const pageRowType: unique symbol;
declare const pageArrayRows: unique symbol;

/** A value inside a query: a field, the current time, or a page function's result. */
type PageExpression<T> = { readonly [pageExpressionType]: T };
/** An expression, or a plain string, number, boolean, or null. */
type PageOperand<T> = PageExpression<T> | T;
type PageCondition = PageExpression<boolean | null>;
type PageValueOf<TValue> = TValue extends PageExpression<infer T> ? T : TValue;
/** Milliseconds, or a duration such as "30 minutes", "24 hours", or "7 days". */
type PageDuration = number | string;
/** A time relative to the moment the page renders. */
type PageTime = PageExpression<Date> & {
  minus(duration: PageDuration): PageTime;
  plus(duration: PageDuration): PageTime;
};
/** Consecutive intervals from since through now. Group times with bucket; charts take it as axis. */
type PageIntervals = BackofficeUiLive<{ every: number; since: number }>;
/** A JSON field. Read nested values by property, such as route.trigger.kind. */
type PageJsonField = PageExpression<unknown> & { readonly [key: string]: PageJsonField };
type PageFields<TRow> = {
  readonly [TKey in keyof TRow]-?: unknown extends TRow[TKey]
    ? PageJsonField
    : PageExpression<TRow[TKey]>;
};
type PageNullable<TRow> = { [TKey in keyof TRow]: TRow[TKey] | null };
/** Rows a query reads: a collection's, or another query's. */
type PageSource<TRow> = { readonly [pageRowType]: TRow };
type PageCollection<TRow> = PageSource<TRow>;
type PageRowOf<TSource> = TSource extends PageSource<infer TRow> ? TRow : never;
/** How a value reaches the interface: times as ISO 8601 strings, everything else as it is. */
type PageShown<T> = T extends Date
  ? string
  : T extends readonly (infer TItem)[]
    ? PageShown<TItem>[]
    : T extends object
      ? { [TKey in keyof T]: PageShown<T[TKey]> }
      : T;
/** A query's rows as a live value for props such as ui.table rows, or rows for ui.each. */
type PageRows<TRow> = PageSource<TRow> & BackofficeUiLive<PageShown<TRow>[]>;
/** A query's rows nested in each selecting row; see toArray. */
type PageArray<TRow> = { readonly [pageArrayRows]: TRow[] };
type PageSelected<TValue> = TValue extends PageArray<infer TRow> ? TRow[] : PageValueOf<TValue>;
type PageValueField<TRow> = {
  /** One field of the first row, such as a count for ui.metric value; whenEmpty shows while there are no rows. */
  value<TField extends keyof TRow & string>(
    field: TField,
    whenEmpty: PageShown<TRow[TField]>,
  ): BackofficeUiLive<PageShown<TRow[TField]>>;
};

/**
 * A live query. Pass it to a prop that shows rows, such as ui.table rows, repeat it with ui.each,
 * or read it as another query's source. Values keep their types; times arrive as ISO 8601 strings.
 */
type PageQuery<TSources, TRow> = PageRows<TRow> &
  PageValueField<TRow> & {
    /**
     * Keeps rows that match a row of source. on returns eq(left, right), where one side reads the
     * sources before the join and the other the joined source, such as eq(run.id, step.instanceRef)
     * or eq(lower(user.email), lower(invite.email)).
     */
    join<TAlias extends string, TJoined>(
      source: Record<TAlias, PageSource<TJoined>>,
      on: (sources: TSources & Record<TAlias, PageFields<TJoined>>) => PageCondition,
    ): PageQuery<TSources & Record<TAlias, PageFields<TJoined>>, TRow>;
    /** Keeps every row; source's fields are null where nothing matches. on is as for join. */
    leftJoin<TAlias extends string, TJoined>(
      source: Record<TAlias, PageSource<TJoined>>,
      on: (sources: TSources & Record<TAlias, PageFields<TJoined>>) => PageCondition,
    ): PageQuery<TSources & Record<TAlias, PageFields<PageNullable<TJoined>>>, TRow>;
    where(condition: (sources: TSources) => PageCondition): PageQuery<TSources, TRow>;
    /** Groups rows by one or more keys; select the keys and aggregates to show. */
    groupBy(
      keys: (sources: TSources) => PageExpression<unknown> | PageExpression<unknown>[],
    ): PageQuery<TSources, TRow>;
    /** Filters groups, usually by an aggregate. */
    having(condition: (sources: TSources) => PageCondition): PageQuery<TSources, TRow>;
    /** Names the fields each row shows. Joined and grouped queries select their fields. */
    select<TSelected extends Record<string, PageOperand<unknown> | PageArray<unknown>>>(
      fields: (sources: TSources) => TSelected,
    ): PageQuery<TSources, { [TKey in keyof TSelected]: PageSelected<TSelected[TKey]> }>;
    /** Sorts rows; call it again for ties. Aggregates sort groups. */
    orderBy(
      value: (sources: TSources) => PageExpression<unknown>,
      direction?: "asc" | "desc",
    ): PageQuery<TSources, TRow>;
    /** Keeps the first count rows, 1 to PageLimits["rowsPerQuery"]; needs orderBy. */
    limit(count: number): PageQuery<TSources, TRow>;
  };

/** Several queries' rows as one list; order or limit it by reading it as a source with from. */
type PageUnion<TRow> = PageRows<TRow> & PageValueField<TRow>;

type PageContext = {
  collections: PageCollections;
  /** Starts a query over a collection or another query's rows under an alias, such as from({ run: collections.workflowInstances }). */
  from<TAlias extends string, TRow>(
    source: Record<TAlias, PageSource<TRow>>,
  ): PageQuery<Record<TAlias, PageFields<TRow>>, TRow>;
  /**
   * A select field holding the rows of query for each selecting row, such as each workflow's
   * latest run. The query is a from, not a unionAll, whose where matches the selecting row with eq,
   * such as eq(run.workflow, workflow.workflow). A grouped query cannot select it, so group in a
   * subquery and read that with from.
   */
  toArray<TRow>(query: PageRows<TRow>): PageArray<TRow>;
  /** One list of every row of 2 to PageLimits["unionBranches"] queries that select the same fields. */
  unionAll<TQueries extends [PageRows<unknown>, PageRows<unknown>, ...PageRows<unknown>[]]>(
    ...queries: TQueries
  ): PageUnion<PageRowOf<TQueries[number]>>;
  /** The moment the page renders; it moves every minute. */
  now: PageTime;
  /**
   * every-long intervals from since through now, including the one now falls in, so 24 hours of
   * 1 hour is 25; at most PageLimits["buckets"].
   */
  intervals(options: { every: PageDuration; since: PageTime }): PageIntervals;
  /** The start of the interval a time falls in, or null before the first. */
  bucket(time: PageExpression<Date | null>, intervals: PageIntervals): PageExpression<Date | null>;
  eq<T>(left: PageOperand<T>, right: PageOperand<T>): PageExpression<boolean>;
  gt<T>(left: PageOperand<T>, right: PageOperand<T>): PageExpression<boolean>;
  gte<T>(left: PageOperand<T>, right: PageOperand<T>): PageExpression<boolean>;
  lt<T>(left: PageOperand<T>, right: PageOperand<T>): PageExpression<boolean>;
  lte<T>(left: PageOperand<T>, right: PageOperand<T>): PageExpression<boolean>;
  and(...conditions: PageCondition[]): PageExpression<boolean>;
  or(...conditions: PageCondition[]): PageExpression<boolean>;
  not(condition: PageCondition): PageExpression<boolean>;
  isNull(value: PageExpression<unknown>): PageExpression<boolean>;
  /** True when value is one of at most PageLimits["listItems"] plain values. */
  inArray<T>(value: PageOperand<T>, list: readonly T[]): PageExpression<boolean>;
  /** SQL LIKE: % matches any text and _ one character. ilike ignores case. */
  like(value: PageOperand<string | null>, pattern: PageOperand<string>): PageExpression<boolean>;
  ilike(value: PageOperand<string | null>, pattern: PageOperand<string>): PageExpression<boolean>;
  /** The first value that is not null. */
  coalesce<T>(...values: PageOperand<T>[]): PageExpression<NonNullable<T>>;
  /**
   * caseWhen(condition, value, ...more pairs, default?): the value of the first true condition, or
   * the default. Literal values keep their type, so a query can choose a ui tone.
   */
  caseWhen<const T>(
    condition: PageCondition,
    value: PageOperand<T>,
    otherwise: PageOperand<T>,
  ): PageExpression<T>;
  caseWhen<const T>(
    condition: PageCondition,
    value: PageOperand<T>,
    condition2: PageCondition,
    value2: PageOperand<T>,
    otherwise: PageOperand<T>,
  ): PageExpression<T>;
  caseWhen<const T>(
    condition: PageCondition,
    value: PageOperand<T>,
    condition2: PageCondition,
    value2: PageOperand<T>,
    condition3: PageCondition,
    value3: PageOperand<T>,
    otherwise: PageOperand<T>,
  ): PageExpression<T>;
  /** Without a default, rows no condition matches hold null. */
  caseWhen<const T>(
    condition: PageCondition,
    value: PageOperand<T>,
    ...rest: (PageCondition | PageOperand<T>)[]
  ): PageExpression<T | null>;
  concat(...values: PageOperand<unknown>[]): PageExpression<string>;
  upper(value: PageOperand<string | null>): PageExpression<string | null>;
  lower(value: PageOperand<string | null>): PageExpression<string | null>;
  length(value: PageOperand<string | null>): PageExpression<number>;
  add(left: PageOperand<number | null>, right: PageOperand<number | null>): PageExpression<number>;
  subtract(
    left: PageOperand<number | Date | null>,
    right: PageOperand<number | Date | null>,
  ): PageExpression<number>;
  multiply(
    left: PageOperand<number | null>,
    right: PageOperand<number | null>,
  ): PageExpression<number>;
  divide(
    left: PageOperand<number | null>,
    right: PageOperand<number | null>,
  ): PageExpression<number | null>;
  /** Counts rows where value is not null. Aggregates belong in select, having, and orderBy. */
  count(value: PageExpression<unknown>): PageExpression<number>;
  sum(value: PageOperand<number | null>): PageExpression<number>;
  avg(value: PageOperand<number | null>): PageExpression<number>;
  min<T>(value: PageExpression<T>): PageExpression<T>;
  max<T>(value: PageExpression<T>): PageExpression<T>;
};

/** A built page: its queries as JSON and the interface bound to them. */
type PageDefinition = {
  version: PageDefinitionVersion;
  queries: Record<string, unknown>;
  values: Record<
    string,
    { query: string; field: string; whenEmpty: string | number | boolean | null }
  >;
  spec: { root: string; elements: Record<string, unknown> };
};

declare const page: {
  /** Builds the page file: build returns the root ui element, with queries in its props. At most PageLimits["queries"] queries. */
  define(build: (context: PageContext) => BackofficeUiElement): PageDefinition;
};
