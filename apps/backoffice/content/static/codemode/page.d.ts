// Generated page builder. page.define records live queries over the scope's synchronized
// collections, in TanStack DB's query style, and binds their results to a ui interface. Default-
// export it from a /workspace/**/<name>.page.js file; the system builds it when it opens.

declare const pageExpressionType: unique symbol;
declare const pageCollectionRow: unique symbol;

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
/** A JSON field. Read nested values by property, such as route.trigger.kind. */
type PageJsonField = PageExpression<unknown> & { readonly [key: string]: PageJsonField };
type PageFields<TRow> = {
  readonly [TKey in keyof TRow]-?: unknown extends TRow[TKey]
    ? PageJsonField
    : PageExpression<TRow[TKey]>;
};
type PageNullable<TRow> = { [TKey in keyof TRow]: TRow[TKey] | null };
type PageCollection<TRow> = { readonly [pageCollectionRow]: TRow };

/**
 * A live query. Pass it to a prop that shows rows, such as ui.table rows; every value reaches the
 * interface as text: times as ISO 8601, JSON as JSON, and null as an empty string.
 */
type PageQuery<TSources, TRow> = BackofficeUiLive<{ [key: string]: string }[]> & {
  /** Keeps rows that match a row of source; on returns eq(field, field). */
  join<TAlias extends string, TJoined>(
    source: Record<TAlias, PageCollection<TJoined>>,
    on: (sources: TSources & Record<TAlias, PageFields<TJoined>>) => PageCondition,
  ): PageQuery<TSources & Record<TAlias, PageFields<TJoined>>, TRow>;
  /** Keeps every row; source's fields are null where nothing matches. */
  leftJoin<TAlias extends string, TJoined>(
    source: Record<TAlias, PageCollection<TJoined>>,
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
  select<TSelected extends Record<string, PageOperand<unknown>>>(
    fields: (sources: TSources) => TSelected,
  ): PageQuery<TSources, { [TKey in keyof TSelected]: PageValueOf<TSelected[TKey]> }>;
  /** Sorts rows; call it again for ties. Aggregates sort groups. */
  orderBy(
    value: (sources: TSources) => PageExpression<unknown>,
    direction?: "asc" | "desc",
  ): PageQuery<TSources, TRow>;
  /** Keeps the first count rows (1-100); needs orderBy. */
  limit(count: number): PageQuery<TSources, TRow>;
  /** One field of the first row as text, such as a count for ui.metric value; whenEmpty shows while there are no rows. */
  value(field: keyof TRow & string, whenEmpty: string): BackofficeUiLive<string>;
};

type PageContext = {
  collections: PageCollections;
  /** Starts a query over one collection under an alias, such as from({ run: collections.workflowInstances }). */
  from<TAlias extends string, TRow>(
    source: Record<TAlias, PageCollection<TRow>>,
  ): PageQuery<Record<TAlias, PageFields<TRow>>, TRow>;
  /** The moment the page renders; it moves every minute. */
  now: PageTime;
  /** The start of the every-long interval a time falls in, from since through now; null before since. At most 60 intervals. */
  bucket(
    time: PageExpression<Date | null>,
    options: { every: PageDuration; since: PageTime },
  ): PageExpression<Date | null>;
  eq<T>(left: PageOperand<T>, right: PageOperand<T>): PageExpression<boolean>;
  gt<T>(left: PageOperand<T>, right: PageOperand<T>): PageExpression<boolean>;
  gte<T>(left: PageOperand<T>, right: PageOperand<T>): PageExpression<boolean>;
  lt<T>(left: PageOperand<T>, right: PageOperand<T>): PageExpression<boolean>;
  lte<T>(left: PageOperand<T>, right: PageOperand<T>): PageExpression<boolean>;
  and(...conditions: PageCondition[]): PageExpression<boolean>;
  or(...conditions: PageCondition[]): PageExpression<boolean>;
  not(condition: PageCondition): PageExpression<boolean>;
  isNull(value: PageExpression<unknown>): PageExpression<boolean>;
  /** True when value is one of at most 100 plain values. */
  inArray<T>(value: PageOperand<T>, list: readonly T[]): PageExpression<boolean>;
  /** SQL LIKE: % matches any text and _ one character. ilike ignores case. */
  like(value: PageOperand<string | null>, pattern: PageOperand<string>): PageExpression<boolean>;
  ilike(value: PageOperand<string | null>, pattern: PageOperand<string>): PageExpression<boolean>;
  /** The first value that is not null. */
  coalesce<T>(...values: PageOperand<T>[]): PageExpression<NonNullable<T>>;
  /** caseWhen(condition, value, ...more pairs, default?): the value of the first true condition. */
  caseWhen<T>(
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
  version: 1;
  queries: Record<string, unknown>;
  values: Record<string, { query: string; field: string; whenEmpty: string }>;
  spec: { root: string; elements: Record<string, unknown> };
};

declare const page: {
  /** Builds the page file: build returns the root ui element, with queries in its props. At most 16 queries. */
  define(build: (context: PageContext) => BackofficeUiElement): PageDefinition;
  /** The file's interface with empty results, to return as $ui so the host validates it. */
  preview(definition: PageDefinition): BackofficeUi;
};

type PageCollections = {
  projects: PageCollection<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    archivedAt: Date | null;
    createdByUserId: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
  /** Automation routes; routeScheduleStates holds a scheduled route's next occurrence by the same id. */
  routes: PageCollection<{
    id: string;
    name: string;
    enabled: boolean;
    priority: number;
    trigger: unknown;
    action: unknown;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    metadata: unknown | null;
  }>;
  routeScheduleStates: PageCollection<{
    id: string;
    initializationAt: Date | null;
    nextOccurrenceAt: Date | null;
  }>;
  routeDispatches: PageCollection<{
    id: string;
    eventId: string;
    rootEventId: string;
    routeId: string;
    routeName: string;
    outcome: unknown | null;
    dispatchedAt: Date;
    status: string;
    failedAttempts: number;
    error: string | null;
  }>;
  /** Automation events, newest by occurredAt. */
  events: PageCollection<{
    id: string;
    scope: unknown;
    source: string;
    eventType: string;
    occurredAt: Date;
    payload: unknown;
    actors: unknown;
    subject: unknown | null;
    createdAt: Date;
    scopeRestriction: unknown | null;
    causation: unknown | null;
    rootEventId: string | null;
  }>;
  eventSources: PageCollection<{
    id: string;
    source: string;
    label: string;
    description: string;
    category: unknown;
    createdAt: Date;
    updatedAt: Date;
  }>;
  eventDefinitions: PageCollection<{
    id: string;
    source: string;
    eventType: string;
    label: string;
    description: string | null;
    payloadSchema: unknown | null;
    actorSchema: unknown | null;
    subjectSchema: unknown | null;
    example: unknown | null;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }>;
  /** Values stored with the store provider. */
  kvStore: PageCollection<{
    id: string;
    key: string;
    value: string;
    description: string | null;
    category: unknown | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  /** Workflow runs. workflowName is the runner's internal name; remoteWorkflowName is the workflow's own name. */
  workflowInstances: PageCollection<{
    id: string;
    workflowName: string;
    remoteWorkflowName: string | null;
    instanceId: string;
    status: string;
    runGeneration: number;
    createdAt: Date;
    updatedAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    params: unknown;
    output: unknown | null;
    errorName: string | null;
    errorMessage: string | null;
    interruptedTicks: number;
  }>;
  /** Steps of workflow runs; instanceRef is the run's id. */
  workflowSteps: PageCollection<{
    id: string;
    instanceRef: string;
    stepKey: string;
    parentStepKey: string | null;
    depth: number;
    name: string;
    type: string;
    status: string;
    committedByExecutionId: string;
    attempts: number;
    maxAttempts: number;
    timeoutMs: number | null;
    nextRetryAt: Date | null;
    wakeAt: Date | null;
    waitEventType: string | null;
    result: unknown | null;
    errorName: string | null;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  workflowEvents: PageCollection<{
    id: string;
    instanceRef: string;
    actor: string;
    type: string;
    payload: unknown | null;
    createdAt: Date;
    deliveredAt: Date | null;
    consumedByStepKey: string | null;
  }>;
};
