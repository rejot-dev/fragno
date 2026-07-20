import type {
  TableToColumnValues,
  TableToInsertValues,
  TableToUpdateValues,
} from "@fragno-dev/db/query";
import type { AnySchema, AnyTable, FragnoId } from "@fragno-dev/db/schema";

import type {
  createHandlerTxBuilder,
  DbInterval,
  DbIntervalInput,
  DbNow,
  HandlerTxBuilder,
} from "@fragno-dev/db";
import type { OutboxEntry } from "@fragno-dev/db";

import type { InMemoryLofiStore } from "./adapters/in-memory/store";
import type { AsyncQueryFindFamily } from "./query-types";

export type LofiOutboxTransport = "poll" | "stream";

export type LofiPollOutboxOptions = {
  outboxTransport?: "poll";
  pollIntervalMs?: number;
  outboxStreamUrl?: never;
  streamReconnectIntervalMs?: never;
};

export type LofiStreamOutboxOptions = {
  outboxTransport: "stream";
  outboxStreamUrl?: string;
  streamReconnectIntervalMs?: number;
  pollIntervalMs?: never;
};

export type LofiOutboxTransportOptions = LofiPollOutboxOptions | LofiStreamOutboxOptions;

export type LofiEphemeralStreamBoundary = "start" | "item" | "end";

export type LofiEphemeralStreamPolicy = {
  /** Returns the identity shared by every row in one recoverable ephemeral stream. */
  key: (values: Record<string, unknown>) => string;
  /** Classifies rows that open, extend, or durably close the stream. */
  boundary: (values: Record<string, unknown>) => LofiEphemeralStreamBoundary;
};

export type LofiEphemeralTable = {
  schema: string;
  table: string;
  /**
   * Keeps active rows replayable while allowing the volatile network cursor to continue advancing.
   * The persisted cursor remains before the earliest open stream until its end row is processed.
   */
  stream?: LofiEphemeralStreamPolicy;
};

export type LofiEphemeralMutationBatch = {
  sourceKey: string;
  uowId: string;
  versionstamp: string;
  mutations: readonly LofiMutation[];
};

export type LofiClientBaseOptions = {
  outboxUrl: string;
  endpointName: string;
  adapter: LofiAdapter;
  ephemeralTables?: readonly LofiEphemeralTable[];
  fetch?: typeof fetch;
  limit?: number;
  cursorKey?: string;
  onSyncApplied?: (result: LofiSyncResult) => void | Promise<void>;
  onSyncComplete?: (result: LofiSyncResult) => void | Promise<void>;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
};

export type LofiClientOptions = LofiClientBaseOptions & LofiOutboxTransportOptions;

export type LofiSyncResult = {
  /**
   * Number of outbox entries accepted during this sync.
   *
   * This includes entries containing ephemeral mutations. It counts outbox entries, not the
   * number of mutations inside them.
   */
  appliedEntries: number;
  /** Versionstamp of the last outbox entry processed, including ephemeral-only entries. */
  lastVersionstamp?: string;
  /** True when the sync stopped because its abort signal was triggered. */
  aborted?: boolean;
  /**
   * Number of non-ephemeral mutations written to the adapter.
   *
   * Present when ephemeral tables are configured, allowing the runtime to avoid refreshing
   * durable queries after an ephemeral-only sync.
   */
  appliedDurableMutations?: number;
};

export type LofiSchemaRegistration = { schema: AnySchema; schemaName?: string };

type Prettify<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]: T[K] }
    : T;

export type LofiMutationOp = LofiMutation["op"];

export type LofiTypedMutation<
  TSchema extends AnySchema,
  TTableName extends keyof TSchema["tables"] & string,
  TOp extends LofiMutationOp,
> = TOp extends "create"
  ? Prettify<
      Omit<Extract<LofiMutation, { op: "create" }>, "schema" | "table" | "values"> & {
        schema: TSchema["name"];
        table: TTableName;
        values: Prettify<TableToInsertValues<TSchema["tables"][TTableName]>>;
      }
    >
  : TOp extends "update"
    ? Prettify<
        Omit<Extract<LofiMutation, { op: "update" }>, "schema" | "table" | "set"> & {
          schema: TSchema["name"];
          table: TTableName;
          set: Prettify<TableToUpdateValues<TSchema["tables"][TTableName]>>;
        }
      >
    : Prettify<
        Omit<Extract<LofiMutation, { op: "delete" }>, "schema" | "table"> & {
          schema: TSchema["name"];
          table: TTableName;
        }
      >;

type LofiDbNowValueKeys<TValues> = {
  [TKey in keyof TValues]-?: [Extract<TValues[TKey], DbNow>] extends [never] ? never : TKey;
}[keyof TValues];

type ResolveLofiMutationValues<TValues, TTable extends AnyTable> = Prettify<
  Omit<TValues, LofiDbNowValueKeys<TValues>> & {
    [TKey in LofiDbNowValueKeys<TValues>]-?: TKey extends keyof TTable["columns"]
      ? TTable["columns"][TKey]["$out"]
      : Exclude<TValues[TKey], DbNow | undefined> | Date;
  }
>;

/** A typed outbox mutation after dates are deserialized and unresolved DbNow is rejected. */
export type LofiResolvedTypedMutation<
  TSchema extends AnySchema,
  TTableName extends keyof TSchema["tables"] & string,
  TOp extends LofiMutationOp,
> = TOp extends "create"
  ? Prettify<
      Omit<LofiTypedMutation<TSchema, TTableName, "create">, "values"> & {
        values: ResolveLofiMutationValues<
          LofiTypedMutation<TSchema, TTableName, "create">["values"],
          TSchema["tables"][TTableName]
        >;
      }
    >
  : TOp extends "update"
    ? Prettify<
        Omit<LofiTypedMutation<TSchema, TTableName, "update">, "set"> & {
          set: ResolveLofiMutationValues<
            LofiTypedMutation<TSchema, TTableName, "update">["set"],
            TSchema["tables"][TTableName]
          >;
        }
      >
    : LofiTypedMutation<TSchema, TTableName, "delete">;

type LofiMutationMatchResult<
  TSchema extends AnySchema,
  TTableName extends keyof TSchema["tables"] & string,
  TOp extends LofiMutationOp | readonly LofiMutationOp[],
> = LofiTypedMutation<
  TSchema,
  TTableName,
  TOp extends readonly LofiMutationOp[] ? TOp[number] : Extract<TOp, LofiMutationOp>
>;

type LofiMutationMatchOne = <
  const TSchema extends AnySchema,
  const TTableName extends keyof TSchema["tables"] & string,
  const TOp extends LofiMutationOp | readonly LofiMutationOp[],
>(
  mutation: LofiMutation,
  schema: TSchema,
  table: TTableName,
  op: TOp,
) => LofiMutationMatchResult<TSchema, TTableName, TOp> | undefined;

export type LofiMutationMatcher = {
  one: LofiMutationMatchOne;
  all: <
    const TSchema extends AnySchema,
    const TTableName extends keyof TSchema["tables"] & string,
    const TOp extends LofiMutationOp | readonly LofiMutationOp[],
  >(
    schema: TSchema,
    table: TTableName,
    op: TOp,
  ) => LofiMutationMatchResult<TSchema, TTableName, TOp>[];
};

export type LofiProjectionRowSnapshot = {
  key: [string, string, string, string];
  endpoint: string;
  schema: string;
  table: string;
  id: string;
  data: Record<string, unknown>;
  _lofi: {
    versionstamp: string;
    norm: Record<string, unknown>;
    internalId: number;
    version: number;
  };
};

export type LofiProjectionRowLookup = {
  getProjectionRow(options: {
    schemaName: string;
    tableName: string;
    externalId: string;
  }): LofiProjectionRowSnapshot | undefined | Promise<LofiProjectionRowSnapshot | undefined>;
};

export type LofiProjectionReadRequest<TValue> = {
  readonly type: "lofi.projection.read.get";
  readonly schema: AnySchema;
  readonly tableName: string;
  readonly externalId: string;
  readonly value?: TValue;
};

type LofiProjectionReadEachGetExternalId<TItem> = {
  bivarianceHack(item: TItem): string;
}["bivarianceHack"];

export type LofiProjectionReadEachRequest<TItem, TValue> = {
  readonly type: "lofi.projection.read.each";
  readonly items: readonly TItem[];
  readonly schema: AnySchema;
  readonly tableName: string;
  readonly getExternalId: LofiProjectionReadEachGetExternalId<TItem>;
  readonly value?: readonly Prettify<{ item: Prettify<TItem>; row: Prettify<TValue> }>[];
};

export type LofiProjectionReadEachBuilder<TItem> = {
  map<TMapped>(
    mapper: (item: TItem) => TMapped | undefined | null | false,
  ): LofiProjectionReadEachBuilder<Exclude<TMapped, undefined | null | false>>;
  get<const TSchema extends AnySchema, TTableName extends keyof TSchema["tables"] & string>(
    schema: TSchema,
    table: TTableName,
    getExternalId: (item: TItem) => string,
  ): LofiProjectionReadEachRequest<
    TItem,
    TableToColumnValues<TSchema["tables"][TTableName]> | undefined
  >;
};

export type LofiLocalProjectionRead = {
  /** Declares a read from projection-owned local schemas only; app/source schemas are rejected. */
  get<const TSchema extends AnySchema, TTableName extends keyof TSchema["tables"] & string>(
    schema: TSchema,
    table: TTableName,
    externalId: string,
  ): LofiProjectionReadRequest<TableToColumnValues<TSchema["tables"][TTableName]> | undefined>;

  /** Starts a composable read plan for a collection of projection items. */
  each<const TItem>(items: readonly TItem[]): LofiProjectionReadEachBuilder<TItem>;

  /** Pairs each item with a projection-owned local row keyed by that item. */
  getEach<
    const TItem,
    const TSchema extends AnySchema,
    TTableName extends keyof TSchema["tables"] & string,
  >(
    items: readonly TItem[],
    schema: TSchema,
    table: TTableName,
    getExternalId: (item: TItem) => string,
  ): LofiProjectionReadEachRequest<
    TItem,
    TableToColumnValues<TSchema["tables"][TTableName]> | undefined
  >;
};

export type LofiProjectionReadPlan =
  | LofiProjectionReadRequest<unknown>
  | LofiProjectionReadEachRequest<unknown, unknown>
  | { readonly [key: string]: LofiProjectionReadPlan }
  | readonly LofiProjectionReadPlan[]
  | undefined
  | null;

export type LofiProjectionResolved<T> =
  T extends LofiProjectionReadRequest<infer TValue>
    ? Prettify<TValue>
    : T extends LofiProjectionReadEachRequest<infer TItem, infer TValue>
      ? readonly Prettify<{ item: Prettify<TItem>; row: Prettify<TValue> }>[]
      : T extends readonly [infer THead, ...infer TTail]
        ? readonly [LofiProjectionResolved<THead>, ...LofiProjectionResolved<TTail>]
        : T extends readonly (infer TItem)[]
          ? readonly LofiProjectionResolved<TItem>[]
          : T extends object
            ? Prettify<{ [K in keyof T]: LofiProjectionResolved<T[K]> }>
            : T;

export type LofiProjectionUpdateBuilder<TTable extends AnyTable> = {
  set(values: TableToUpdateValues<TTable>): LofiProjectionUpdateBuilder<TTable>;
  check(): LofiProjectionUpdateBuilder<TTable>;
  now(): DbNow;
  interval(input: DbIntervalInput): DbInterval;
};

export type LofiProjectionSchemaTx<TSchema extends AnySchema> = {
  create<const TTableName extends keyof TSchema["tables"] & string>(
    table: TTableName,
    values: TableToInsertValues<TSchema["tables"][TTableName]>,
  ): FragnoId;
  update<const TTableName extends keyof TSchema["tables"] & string>(
    table: TTableName,
    externalId: string | FragnoId,
    builder: (
      b: LofiProjectionUpdateBuilder<TSchema["tables"][TTableName]>,
    ) => LofiProjectionUpdateBuilder<TSchema["tables"][TTableName]> | void,
  ): void;
  delete(table: keyof TSchema["tables"] & string, externalId: string | FragnoId): void;
};

export type LofiProjectionTx = {
  forSchema<const TSchema extends AnySchema>(schema: TSchema): LofiProjectionSchemaTx<TSchema>;
};

export type LofiLocalProjectionRetrieveContext = {
  mutations: readonly LofiMutation[];
  source: {
    sourceKey?: string;
    uowId?: string;
    versionstamp: string;
  };
  match: LofiMutationMatcher;
  read: LofiLocalProjectionRead;
};

export type LofiLocalProjectionMutateContext<TRetrieved = unknown> = {
  mutations: readonly LofiMutation[];
  source: {
    sourceKey?: string;
    uowId?: string;
    versionstamp: string;
  };
  match: LofiMutationMatcher;
  retrieved: TRetrieved;
  tx: LofiProjectionTx;
};

export type LofiLocalProjectionContext<TRetrieved = unknown> =
  LofiLocalProjectionMutateContext<TRetrieved>;

export type LofiProjectionRetrieved<TRetrieve extends LofiProjectionReadPlan | void> = [
  TRetrieve,
] extends [undefined | void]
  ? undefined
  : LofiProjectionResolved<Exclude<TRetrieve, undefined | void>>;

type LofiLocalProjectionMutateHandler<TRetrieved> = {
  bivarianceHack(ctx: LofiLocalProjectionMutateContext<TRetrieved>): unknown;
}["bivarianceHack"];

export type LofiLocalProjection<TRetrieve extends LofiProjectionReadPlan | void = undefined> = {
  name?: string;
  retrieve?: (ctx: LofiLocalProjectionRetrieveContext) => TRetrieve;
  mutate: LofiLocalProjectionMutateHandler<LofiProjectionRetrieved<TRetrieve>>;
};

export type AnyLofiLocalProjection = LofiLocalProjection<LofiProjectionReadPlan | void>;

export type LofiAdapter = {
  applyOutboxEntry(options: {
    sourceKey: string;
    versionstamp: string;
    uowId: string;
    mutations: LofiMutation[];
  }): Promise<{ applied: boolean }>;
  applyMutations?(mutations: LofiMutation[]): Promise<void>;
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
};

export type IndexedDbAdapterOptions = {
  dbName?: string;
  endpointName: string;
  schemas: LofiSchemaRegistration[];
  localSchemas?: LofiSchemaRegistration[];
  projections?: AnyLofiLocalProjection[];
  ignoreUnknownSchemas?: boolean;
};

export type InMemoryLofiAdapterOptions = {
  endpointName: string;
  schemas: AnySchema[];
  localSchemas?: AnySchema[];
  projections?: AnyLofiLocalProjection[];
  ignoreUnknownSchemas?: boolean;
  store?: InMemoryLofiStore;
};

export type LofiQueryInterface<TSchema extends AnySchema> = AsyncQueryFindFamily<TSchema>;

export type LofiQueryEngineOptions = {
  schemaName?: string;
};

export interface LofiQueryableAdapter {
  createQueryEngine<const T extends AnySchema>(
    schema: T,
    options?: LofiQueryEngineOptions,
  ): LofiQueryInterface<T>;
}

export type LofiSubmitCommandTarget = {
  fragment: string;
  schema: string;
};

export type LofiSubmitCommand = {
  id: string;
  name: string;
  target: LofiSubmitCommandTarget;
  input: unknown;
};

export type LofiSubmitConflictReason =
  | "conflict"
  | "write_congestion"
  | "client_far_behind"
  | "no_commands"
  | "already_handled"
  | "limit_exceeded";

export type LofiSubmitRequest = {
  baseVersionstamp?: string;
  requestId: string;
  conflictResolutionStrategy: "server" | "disabled";
  adapterIdentity: string;
  commands: LofiSubmitCommand[];
};

export type LofiSubmitAppliedResponse = {
  status: "applied";
  requestId: string;
  confirmedCommandIds: string[];
  lastVersionstamp?: string;
  entries: OutboxEntry[];
};

export type LofiSubmitConflictResponse = {
  status: "conflict";
  requestId: string;
  confirmedCommandIds: string[];
  conflictCommandId?: string;
  lastVersionstamp?: string;
  entries: OutboxEntry[];
  reason: LofiSubmitConflictReason;
};

export type LofiSubmitResponse = LofiSubmitAppliedResponse | LofiSubmitConflictResponse;

type HandlerTxOptions = Parameters<typeof createHandlerTxBuilder>[0];

export type LofiSyncCommandTxFactory = (
  options?: Omit<HandlerTxOptions, "createUnitOfWork">,
) => HandlerTxBuilder<readonly [], [], [], unknown, unknown, false, false, false, false, {}>;

export type LofiSubmitCommandDefinition<TInput = unknown, TContext = unknown> = {
  name: string;
  target: LofiSubmitCommandTarget;
  handler: (args: {
    input: TInput;
    tx: LofiSyncCommandTxFactory;
    ctx: TContext;
  }) => Promise<unknown>;
};

export type LofiMutation =
  | {
      op: "create";
      schema: string;
      table: string;
      externalId: string;
      values: Record<string, unknown>;
      versionstamp: string;
    }
  | {
      op: "update";
      schema: string;
      table: string;
      externalId: string;
      set: Record<string, unknown>;
      versionstamp: string;
    }
  | {
      op: "delete";
      schema: string;
      table: string;
      externalId: string;
      versionstamp: string;
    };
