/// <reference path="/static/codemode/page-schema.d.ts" />
// The page builder. page.define records live SQL queries over the scope's relations and binds
// their rows to a ui interface. Default-export it from a /workspace/**/<name>.page.js file; the
// system builds it when it opens. page-schema.d.ts declares the relations, their columns, the
// functions queries call, and PageLimits.

declare const pageSqlText: unique symbol;
declare const pageTimeValue: unique symbol;

/** Milliseconds, or a duration such as "30 minutes", "24 hours", or "7 days". */
type PageDuration = number | string;
/** A time relative to the moment the page renders; SQL reads it as milliseconds since the epoch. */
type PageTime = {
  readonly [pageTimeValue]: true;
  minus(duration: PageDuration): PageTime;
  plus(duration: PageDuration): PageTime;
};
/** Consecutive intervals from since through now. Group times with bucket; charts take it as axis. */
type PageIntervals = BackofficeUiLive<{ every: number; since: number }>;

type PageSqlLiteral = string | number | boolean | null;
/**
 * What sql`...` takes between ${ and }: a value it binds as a parameter, never writing it into the
 * SQL; a list of values for IN (...); a time; or SQL to include, such as another query's.
 */
type PageSqlValue =
  | PageSqlLiteral
  | readonly PageSqlLiteral[]
  | PageTime
  | PageSql
  | PageQuery<unknown>;

type PageScalarColumn = "string" | "number" | "boolean" | "time" | "json";
/**
 * How a query's column reads: "string", "number", "boolean" (from 0 or 1), "time" (from
 * milliseconds since the epoch, shown as an ISO 8601 string), or "json" (parsed from JSON text),
 * each with ? when it may be null, such as "time?"; a list of the strings it holds, such as
 * ["live", "failed"], with null when it may be null; or { rows: { ...columns } } for JSON text
 * holding rows, such as json_group_array(json_object('status', run.status)).
 */
type PageColumn =
  | PageScalarColumn
  | `${PageScalarColumn}?`
  | readonly (string | null)[]
  | { readonly rows: PageColumns };
type PageColumns = { readonly [name: string]: PageColumn };

type PageScalarValue<TColumn> = TColumn extends "string" | "time"
  ? string
  : TColumn extends "number"
    ? number
    : TColumn extends "boolean"
      ? boolean
      : unknown;
type PageColumnValue<TColumn> = TColumn extends `${infer TScalar}?`
  ? PageScalarValue<TScalar> | null
  : TColumn extends PageScalarColumn
    ? PageScalarValue<TColumn>
    : TColumn extends readonly (infer TValue)[]
      ? TValue
      : TColumn extends { readonly rows: infer TRows }
        ? PageRow<TRows>[]
        : never;
/** A row as its query's columns declare it. */
type PageRow<TColumns> = { -readonly [TName in keyof TColumns]: PageColumnValue<TColumns[TName]> };

/** SQL with its values, which a query and other SQL can include. */
type PageSql = {
  readonly [pageSqlText]: true;
  /**
   * Declares the columns the rows show, which makes the SQL a live query. Its SELECT names each
   * column, such as count(*) AS total.
   */
  columns<const TColumns extends PageColumns>(columns: TColumns): PageQuery<PageRow<TColumns>>;
};

/**
 * A live query. Pass it to a prop that shows rows, such as ui.table rows, repeat it with ui.each,
 * or include its SQL in another query, such as WITH runs AS (${query}).
 */
type PageQuery<TRow> = BackofficeUiLive<TRow[]> & {
  readonly [pageSqlText]: true;
  /** One field of the first row, such as a count for ui.metric value; whenEmpty shows while there are no rows. */
  value<TField extends keyof TRow & string>(
    field: TField,
    whenEmpty: TRow[TField],
  ): BackofficeUiLive<TRow[TField]>;
};

type PageContext = {
  /**
   * SQL over PageRelations, as a tagged template: sql`SELECT ... WHERE run.createdAt >= ${day}`.
   * Each query is one SELECT, and may start with WITH.
   */
  sql(strings: TemplateStringsArray, ...values: PageSqlValue[]): PageSql;
  /** The moment the page renders; it moves every minute. */
  now: PageTime;
  /**
   * every-long intervals from since through now, including the one now falls in, so 24 hours of
   * 1 hour is 25; at most PageLimits["buckets"].
   */
  intervals(options: { every: PageDuration; since: PageTime }): PageIntervals;
  /**
   * SQL for the start of the interval a time falls in, or null before the first, such as
   * bucket("run.createdAt", hours). Declare its column "time?", and group by it.
   */
  bucket(time: string | PageSql, intervals: PageIntervals): PageSql;
};

/** A built page: its queries and the interface bound to them. */
type PageDefinition = {
  version: PageDefinitionVersion;
  title: string;
  queries: Record<string, { sql: string; params: unknown[]; columns: PageColumns }>;
  values: Record<
    string,
    { query: string; field: string; whenEmpty: string | number | boolean | null }
  >;
  spec: { root: string; elements: Record<string, unknown> };
};

declare const page: {
  /**
   * Builds the page file. The title, at most PageLimits["titleLength"] characters, heads the page;
   * build returns the root ui element, with queries in its props. At most PageLimits["queries"]
   * queries.
   */
  define(
    options: { title: string },
    build: (context: PageContext) => BackofficeUiElement,
  ): PageDefinition;
};
