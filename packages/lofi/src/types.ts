import type { createHandlerTxBuilder, HandlerTxBuilder } from "@fragno-dev/db";
import type { OutboxEntry } from "@fragno-dev/db";
import type { AnySchema } from "@fragno-dev/db/schema";
import type { SimpleQueryInterface } from "@fragno-dev/db/query";
import type { InMemoryLofiStore } from "./adapters/in-memory/store";

export type LofiClientOptions = {
  outboxUrl: string;
  endpointName: string;
  adapter: LofiAdapter;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  limit?: number;
  cursorKey?: string;
  onSyncApplied?: (result: LofiSyncResult) => void | Promise<void>;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
};

export type LofiSyncResult = {
  appliedEntries: number;
  lastVersionstamp?: string;
};

export type LofiSchemaRegistration = { schema: AnySchema };

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
  ignoreUnknownSchemas?: boolean;
};

export type InMemoryLofiAdapterOptions = {
  endpointName: string;
  schemas: AnySchema[];
  ignoreUnknownSchemas?: boolean;
  store?: InMemoryLofiStore;
};

export type LofiQueryInterface<TSchema extends AnySchema> = {
  find: SimpleQueryInterface<TSchema>["find"];
  findFirst: SimpleQueryInterface<TSchema>["findFirst"];
  findWithCursor: SimpleQueryInterface<TSchema>["findWithCursor"];
};

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
      op: "upsert";
      schema: string;
      table: string;
      externalId: string;
      conflictIndex: string;
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
