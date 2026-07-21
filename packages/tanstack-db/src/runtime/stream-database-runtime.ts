import { type DurableStream, type JsonBatch } from "@durable-streams/client";
import type { StateEvent } from "@durable-streams/state";
import type { ProtocolEnvelope } from "@tanstack/db-sqlite-persistence-core";

import {
  DurableStreamConsumer,
  type StreamConsumerMode,
} from "../consumer/durable-stream-consumer";
import { compareStreamOffsets, parseStreamOffset } from "../consumer/stream-offset";
import { StreamStatusController, type FragnoStreamDBStatus } from "../consumer/stream-status";
import { TransactionIdTracker } from "../consumer/transaction-id-tracker";
import { CoordinatedConsumerRuntime } from "../coordination/coordinated-consumer";
import {
  createTerminalErrorMessage,
  parseCommittedCheckpoint,
  parseHeartbeatLeaderId,
  parseTerminalError,
} from "../coordination/coordinator-messages";
import type { AnyFragnoStateSchema } from "../state/fragno-state-schema";
import {
  MaterializedStateRuntime,
  type FragnoStreamDBCollections,
} from "../tanstack/materialized-state-runtime";
import type { FragnoStreamDBPersistence, StreamCheckpoint } from "../tanstack/state-sink";

export type StreamDatabaseRuntimeOptions<TState extends AnyFragnoStateSchema> = {
  state: TState;
  stream: DurableStream;
  live?: StreamConsumerMode;
  persistence?: FragnoStreamDBPersistence;
  onEvent?: (event: StateEvent) => void;
  onBeforeBatch?: (batch: JsonBatch<StateEvent>) => void;
  onBatch?: (batch: JsonBatch<StateEvent>) => void;
  onError?: (error: Error) => void;
};

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(typeof value === "string" ? value : String(value));

/** Owns synchronization, leadership, status, error propagation, and deterministic shutdown. */
export class StreamDatabaseRuntime<TState extends AnyFragnoStateSchema> {
  readonly stream: DurableStream;
  readonly collections: FragnoStreamDBCollections<TState>;
  readonly utils: { awaitTxId(txid: string, timeout?: number): Promise<void> };
  readonly #options: StreamDatabaseRuntimeOptions<TState>;
  readonly #status = new StreamStatusController();
  readonly #materializedState: MaterializedStateRuntime<TState>;
  readonly #consumer: DurableStreamConsumer;
  readonly #consumeAbortController = new AbortController();
  readonly #coordination: CoordinatedConsumerRuntime;
  readonly #configuredConsumerMode: StreamConsumerMode;
  readonly #transactionIds = new TransactionIdTracker();
  #terminalErrorPublished = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #finiteConsumerPromise: Promise<void> | undefined;
  #liveConsumerPromise: Promise<void> | undefined;
  #observedLeaderId: string | undefined;

  constructor(options: StreamDatabaseRuntimeOptions<TState>) {
    this.#options = options;
    this.stream = options.stream;
    this.#consumer = new DurableStreamConsumer(this.stream);
    this.#configuredConsumerMode = options.live ?? "long-poll";
    this.#materializedState = new MaterializedStateRuntime<TState>({
      state: options.state,
      streamUrl: this.stream.url,
      persistence: options.persistence,
      waitForStreamReady: () => this.#status.waitUntilReady(),
      onActivation: () => this.#activateSource(),
      onPrepared: (checkpoint) => this.#status.markLoading(checkpoint?.offset ?? "-1"),
      onEvent: options.onEvent,
    });
    this.collections = this.#materializedState.collections;
    this.utils = {
      awaitTxId: (txid, timeout) => this.#awaitTxId(txid, timeout),
    };
    this.#coordination = new CoordinatedConsumerRuntime({
      coordinator: this.#materializedState.coordinator,
      collectionId: this.#materializedState.sourceCollectionId,
      startConsumer: (mode) => this.#startConsumer(mode),
      onMessage: (message) => this.#handleCoordinatorMessage(message),
      onError: (error) => this.#fail(error),
    });
  }

  get status(): FragnoStreamDBStatus {
    return this.#status.current;
  }

  get offset(): string {
    return this.#status.offset;
  }

  async preload(): Promise<void> {
    this.#assertOpen();
    this.#requestConsumer(this.#configuredConsumerMode);
    await this.#materializedState.prepare();
    await this.#status.waitUntilReady();
  }

  async syncOnce(): Promise<FragnoStreamDBStatus> {
    this.#assertOpen();
    if (this.#liveConsumerPromise) {
      await this.#status.waitUntilReady();
      return this.#status.current;
    }

    this.#requestConsumer(false);
    await this.#materializedState.prepare();
    if (!this.#coordination.isCurrentLeader()) {
      await this.#status.waitUntilReady();
      return this.#status.current;
    }

    await this.#runFiniteConsumer();
    return this.#status.current;
  }

  async drain(options: { afterOffset?: string } = {}): Promise<FragnoStreamDBStatus> {
    this.#assertOpen();
    if (options.afterOffset !== undefined) {
      await this.#status.waitUntilReadyAfterOffset(options.afterOffset);
    } else {
      // Subscriber activation is synchronous today, but yielding once also covers adapters that
      // notify subscriber changes in a microtask without turning drain() into a sync trigger.
      await Promise.resolve();

      if (this.#finiteConsumerPromise) {
        await this.#finiteConsumerPromise;
      } else if (
        this.#coordination.hasRequestedConsumer ||
        this.#liveConsumerPromise !== undefined ||
        this.#status.current.status === "loading"
      ) {
        await this.#materializedState.prepare();
        await this.#status.waitUntilReady();
      }
    }

    await this.#materializedState.waitForPersistenceIdle();
    if (this.#status.current.status === "error") {
      throw this.#status.current.error;
    }
    return this.#status.current;
  }

  close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#closed = true;
    this.#coordination.close();
    const closeError = new Error("Fragno stream database closed.");
    this.#materializedState.beginClose(closeError);
    this.#consumeAbortController.abort(closeError);
    this.#transactionIds.rejectAll(closeError);
    this.#status.markClosed();

    this.#closePromise = this.#finishClose();
    return this.#closePromise;
  }

  subscribeStatus(listener: (status: FragnoStreamDBStatus) => void): () => void {
    return this.#status.subscribe(listener);
  }

  #awaitTxId(txid: string, timeout = 5_000): Promise<void> {
    this.#assertOpen();
    if (this.#status.current.status === "error") {
      return Promise.reject(this.#status.current.error);
    }
    return this.#transactionIds.waitFor(txid, timeout);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Fragno stream database is closed.");
    }
  }

  #publishTerminalError(error: Error): void {
    if (
      this.#terminalErrorPublished ||
      !this.#materializedState.coordinator ||
      !this.#coordination.isCurrentLeader()
    ) {
      return;
    }

    this.#terminalErrorPublished = true;
    this.#coordination.publish(
      createTerminalErrorMessage({
        ownerId: this.#coordination.ownerId,
        offset: this.#status.offset,
        error,
      }),
    );
  }

  #fail(
    value: unknown,
    options: { broadcast?: boolean; markCollectionError?: boolean } = {},
  ): Error {
    const transition = this.#status.markError(toError(value));
    if (!transition.enteredError) {
      return transition.error;
    }

    this.#transactionIds.rejectAll(transition.error);
    if (options.markCollectionError) {
      this.#materializedState.markTerminalError();
    }
    if (options.broadcast !== false) {
      this.#publishTerminalError(transition.error);
    }
    this.#options.onError?.(transition.error);
    return transition.error;
  }

  async #acceptCheckpoint(checkpoint: StreamCheckpoint): Promise<void> {
    if (this.#status.current.status === "error" || this.#status.current.status === "closed") {
      return;
    }
    if (checkpoint.cacheVersion !== this.#materializedState.persistenceVersion) {
      return;
    }
    if (compareStreamOffsets(checkpoint.offset, this.#status.offset) < 0) {
      throw this.#fail(
        new Error(
          `Fragno stream offset moved backward from ${this.#status.offset} to ${checkpoint.offset}.`,
        ),
      );
    }

    this.#status.observeOffset(checkpoint.offset);
    if (checkpoint.upToDate) {
      await this.#materializedState.markReady();
      this.#status.markReady();
    } else {
      this.#status.markLoading(checkpoint.offset);
    }
  }

  async #handleCoordinatorMessage(message: ProtocolEnvelope<unknown>): Promise<void> {
    const terminalError = parseTerminalError(message);
    if (terminalError) {
      const fromStaleLeader =
        this.#observedLeaderId !== undefined && terminalError.ownerId !== this.#observedLeaderId;
      const behindCurrentCheckpoint =
        compareStreamOffsets(terminalError.offset, this.#status.offset) < 0;
      if (!fromStaleLeader && !behindCurrentCheckpoint) {
        this.#fail(terminalError.error, {
          broadcast: false,
          markCollectionError: true,
        });
      }
      return;
    }

    const committedCheckpoint = parseCommittedCheckpoint(message);
    if (
      committedCheckpoint &&
      message.senderId !== this.#coordination.ownerId &&
      committedCheckpoint.ownerId === message.senderId
    ) {
      await this.#materializedState.waitForCheckpointGeneration(committedCheckpoint.generation);
      await this.#acceptCheckpoint(committedCheckpoint);
      return;
    }

    const leaderId = parseHeartbeatLeaderId(message);
    if (!leaderId) {
      return;
    }
    this.#observedLeaderId = leaderId;
    const checkpoint = this.#materializedState.currentCheckpoint();
    if (checkpoint?.ownerId === leaderId) {
      await this.#acceptCheckpoint(checkpoint);
    }
  }

  async #processStreamBatch(batch: JsonBatch<unknown>): Promise<void> {
    const batchOffset = parseStreamOffset(batch.offset, "Durable Streams batch offset");
    if (compareStreamOffsets(batchOffset, this.#status.offset) < 0) {
      throw new Error(
        `Fragno stream offset moved backward from ${this.#status.offset} to ${batchOffset}.`,
      );
    }

    const stateBatch = batch as JsonBatch<StateEvent>;
    this.#options.onBeforeBatch?.(stateBatch);
    const committed = await this.#materializedState.commitBatch(
      batch,
      this.#coordination.ownerId,
      batchOffset,
    );
    await this.#acceptCheckpoint(committed.checkpoint);
    this.#transactionIds.observe(committed.txids);
    this.#options.onBatch?.(stateBatch);
  }

  async #consume(mode: StreamConsumerMode): Promise<void> {
    this.#assertOpen();
    this.#status.beginSynchronization();
    await this.#materializedState.prepare();
    this.#assertOpen();

    await this.#consumer.consume({
      offset: this.#status.offset,
      mode,
      signal: this.#consumeAbortController.signal,
      processBatch: async (batch) => {
        try {
          await this.#processStreamBatch(batch);
        } catch (error) {
          const processingError = toError(error);
          this.#fail(processingError, { markCollectionError: mode !== false });
          throw processingError;
        }
      },
    });
  }

  #runFiniteConsumer(): Promise<void> {
    if (this.#finiteConsumerPromise) {
      return this.#finiteConsumerPromise;
    }

    const consumer = this.#consume(false)
      .catch((error) => {
        if (
          !this.#closed &&
          !this.#consumeAbortController.signal.aborted &&
          this.#status.current.status !== "error"
        ) {
          this.#fail(error);
        }
        throw error;
      })
      .finally(() => {
        if (this.#finiteConsumerPromise === consumer) {
          this.#finiteConsumerPromise = undefined;
          this.#coordination.reevaluateLeadership();
        }
      });
    this.#finiteConsumerPromise = consumer;
    return consumer;
  }

  #startLiveConsumer(): void {
    if (this.#liveConsumerPromise) {
      return;
    }

    this.#liveConsumerPromise = this.#consume("long-poll").catch((error) => {
      if (
        !this.#closed &&
        !this.#consumeAbortController.signal.aborted &&
        this.#status.current.status !== "error"
      ) {
        this.#fail(error, { markCollectionError: true });
      }
    });
  }

  #startConsumer(mode: StreamConsumerMode): boolean {
    if (this.#closed) {
      return false;
    }
    if (mode === false) {
      void this.#runFiniteConsumer().catch(() => undefined);
      return true;
    }
    if (this.#finiteConsumerPromise) {
      return false;
    }
    this.#startLiveConsumer();
    return true;
  }

  #requestConsumer(mode: StreamConsumerMode): void {
    this.#materializedState.ensureSourceObservation();
    this.#coordination.request(mode);
  }

  #activateSource(): void {
    this.#assertOpen();
    void this.#materializedState.prepare().catch((error) => {
      if (!this.#closed && this.#status.current.status !== "error") {
        this.#fail(error);
      }
    });
    this.#requestConsumer(this.#configuredConsumerMode);
  }

  async #finishClose(): Promise<void> {
    try {
      await Promise.allSettled(
        [this.#liveConsumerPromise, this.#finiteConsumerPromise].filter(
          (promise): promise is Promise<void> => promise !== undefined,
        ),
      );
    } finally {
      await this.#materializedState.finishClose();
    }
  }
}
