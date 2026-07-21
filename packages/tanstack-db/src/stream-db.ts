import { DurableStream, type JsonBatch } from "@durable-streams/client";
import type { StateEvent } from "@durable-streams/state";

import type { StreamConsumerMode } from "./consumer/durable-stream-consumer";
import type { FragnoStreamDBStatus } from "./consumer/stream-status";
import { StreamDatabaseRuntime } from "./runtime/stream-database-runtime";
import {
  type AnyFragnoStateSchema,
  type FragnoStateSchema,
  type FragnoStateSchemaInput,
  type FragnoStreamRow,
} from "./state/fragno-state-schema";
import type { FragnoStreamDBCollections } from "./tanstack/materialized-state-runtime";
import type { FragnoStreamDBPersistence } from "./tanstack/state-sink";

export type {
  FragnoStateSchema,
  FragnoStateSchemaInput,
  FragnoStreamDBPersistence,
  FragnoStreamDBStatus,
  FragnoStreamRow,
};
export { createFragnoStateSchema } from "./state/fragno-state-schema";

type DurableStreamOptions = ConstructorParameters<typeof DurableStream>[0];

type FragnoStreamDBBaseOptions<TState extends AnyFragnoStateSchema> = {
  /** Explicit public collection names and their physical Fragno tables. */
  state: TState;
  /** Defaults to long-poll, the live transport supported by Fragno's state projection. */
  live?: StreamConsumerMode;
  /** Optional TanStack persistence. Browser apps can supply the official OPFS SQLite provider. */
  persistence?: FragnoStreamDBPersistence;
  onEvent?: (event: StateEvent) => void;
  onBeforeBatch?: (batch: JsonBatch<StateEvent>) => void;
  onBatch?: (batch: JsonBatch<StateEvent>) => void;
  onError?: (error: Error) => void;
};

export type CreateFragnoStreamDBOptions<TState extends AnyFragnoStateSchema> =
  FragnoStreamDBBaseOptions<TState> &
    (
      | {
          /** Construct a DurableStream with the same option shape used by upstream createStreamDB(). */
          streamOptions: Omit<DurableStreamOptions, "contentType">;
          stream?: never;
        }
      | {
          /** Reuse an existing DurableStream instead of constructing one from streamOptions. */
          stream: DurableStream;
          streamOptions?: never;
        }
    );

export type FragnoStreamDBDrainOptions = {
  /** Wait until a ready checkpoint advances beyond this offset. */
  afterOffset?: string;
};

export type { FragnoStreamDBCollections } from "./tanstack/materialized-state-runtime";

export type FragnoStreamDB<TState extends AnyFragnoStateSchema = AnyFragnoStateSchema> = {
  readonly stream: DurableStream;
  readonly collections: FragnoStreamDBCollections<TState>;
  readonly status: FragnoStreamDBStatus;
  readonly offset: string;
  readonly utils: {
    awaitTxId(txid: string, timeout?: number): Promise<void>;
  };
  preload(): Promise<void>;
  syncOnce(): Promise<FragnoStreamDBStatus>;
  /**
   * Wait for synchronization without starting a new consumer.
   * Pass `afterOffset` to wait for a later ready checkpoint from an active live consumer.
   */
  drain(options?: FragnoStreamDBDrainOptions): Promise<FragnoStreamDBStatus>;
  close(): Promise<void>;
  subscribeStatus(listener: (status: FragnoStreamDBStatus) => void): () => void;
};

const assertValidCreateOptions = (
  options: CreateFragnoStreamDBOptions<AnyFragnoStateSchema>,
): void => {
  if (!options.stream && !options.streamOptions) {
    throw new Error("createFragnoStreamDB requires streamOptions or stream.");
  }
  if (options.stream && options.streamOptions) {
    throw new Error("createFragnoStreamDB accepts either stream or streamOptions, not both.");
  }
  if (options.persistence?.scope.trim().length === 0) {
    throw new Error("createFragnoStreamDB persistence requires a non-empty scope.");
  }
  if (
    options.persistence &&
    (!Number.isInteger(options.persistence.version) || options.persistence.version < 0)
  ) {
    throw new Error("createFragnoStreamDB persistence requires a non-negative integer version.");
  }
};

const createDurableStream = (
  options: CreateFragnoStreamDBOptions<AnyFragnoStateSchema>,
): DurableStream => {
  if (options.stream) {
    return options.stream;
  }
  return new DurableStream({
    ...options.streamOptions,
    contentType: "application/json",
  });
};

/**
 * Create server-authoritative TanStack DB collections backed by Fragno's Durable Streams State
 * Protocol projection.
 *
 * Application writes continue through Fragno routes or sync commands and become visible after the
 * corresponding outbox transaction has committed and its state checkpoint has been accepted.
 */
export function createFragnoStreamDB<const TState extends AnyFragnoStateSchema>(
  options: CreateFragnoStreamDBOptions<TState>,
): FragnoStreamDB<TState> {
  assertValidCreateOptions(options);
  return new StreamDatabaseRuntime<TState>({
    state: options.state,
    stream: createDurableStream(options),
    live: options.live,
    persistence: options.persistence,
    onEvent: options.onEvent,
    onBeforeBatch: options.onBeforeBatch,
    onBatch: options.onBatch,
    onError: options.onError,
  });
}
