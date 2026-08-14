import { FRAGNO_OUTBOX_PAGE_SIZE, outboxPageAfterVersionstamp } from "@fragno-dev/db/outbox";
import type { AnySchema } from "@fragno-dev/db/schema";

import type { OutboxOperation } from "@fragno-dev/db";

import {
  checkpointForEntry,
  shouldApplyOutboxEntry,
  type FragnoOutboxCheckpoint,
} from "../checkpoint";
import { consumeNdjsonOutboxStream } from "../outbox-stream";
import {
  decodeFragnoOutboxPayload,
  fragnoOutboxOperationTarget,
  projectFragnoOutboxOperations,
  type FragnoCollectionChange,
  type FragnoOutboxEntry,
} from "../protocol";
type FragnoSynchronizedRow = Record<string, unknown>;

type FragnoOutboxFetcher = {
  listOutbox(options: {
    afterVersionstamp?: string;
    signal?: AbortSignal;
  }): Promise<FragnoOutboxEntry[]>;
  openOutboxStream(options: {
    afterVersionstamp?: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>>;
};

type FragnoOutboxCheckpointStore = {
  getCheckpoint(): FragnoOutboxCheckpoint | undefined;
  setCheckpoint(checkpoint: FragnoOutboxCheckpoint): void;
};

export type FragnoOutboxTarget = {
  key: string;
  namespace: string;
  schema: AnySchema;
  tableName: string;
};

export type FragnoOutboxDelivery = {
  checkpoint: FragnoOutboxCheckpoint;
  changes: FragnoCollectionChange<FragnoSynchronizedRow>[];
};

export type FragnoOutboxSubscriber = {
  target: FragnoOutboxTarget;
  prepareCatchUp?(): Promise<void>;
  apply(delivery: FragnoOutboxDelivery): void;
  applyBatch(deliveries: readonly FragnoOutboxDelivery[]): void;
  truncate(): void;
  markReady(): void;
};

type RegistrationWaiter = {
  targets: readonly string[];
  resolve(): void;
  reject(error: Error): void;
};

/** Owns shared outbox ordering and delivers target-specific changes to collection adapters. */
export class FragnoOutboxSynchronizer {
  readonly #fetcher: FragnoOutboxFetcher;
  readonly #checkpointStore: FragnoOutboxCheckpointStore;
  readonly #abortController = new AbortController();
  readonly #subscribers = new Map<string, FragnoOutboxSubscriber>();
  readonly #registrationWaiters = new Set<RegistrationWaiter>();

  #catchUpPromise: Promise<void> | undefined;
  #streamPromise: Promise<void> | undefined;
  #caughtUp = false;
  #disposed = false;

  readonly #onCatchUpPage?: (checkpoint: FragnoOutboxCheckpoint | undefined) => void;

  constructor(options: {
    fetcher: FragnoOutboxFetcher;
    checkpointStore: FragnoOutboxCheckpointStore;
    onCatchUpPage?: (checkpoint: FragnoOutboxCheckpoint | undefined) => void;
  }) {
    this.#fetcher = options.fetcher;
    this.#checkpointStore = options.checkpointStore;
    this.#onCatchUpPage = options.onCatchUpPage;
  }

  register(subscriber: FragnoOutboxSubscriber): () => void {
    if (this.#disposed) {
      throw new Error("Cannot register a collection after Fragno outbox synchronization disposal.");
    }

    this.#subscribers.set(subscriber.target.key, subscriber);
    this.#resolveRegistrationWaiters();

    return () => {
      if (this.#subscribers.get(subscriber.target.key) === subscriber) {
        this.#subscribers.delete(subscriber.target.key);
      }
    };
  }

  waitUntilRegistered(targets: readonly string[]): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(new Error("Fragno outbox synchronization has been disposed."));
    }
    if (this.#hasEveryTarget(targets)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.#registrationWaiters.add({ targets, resolve, reject });
    });
  }

  catchUp(): Promise<void> {
    this.#catchUpPromise ??= this.#runCatchUp();
    return this.#catchUpPromise;
  }

  async replay(): Promise<void> {
    if (this.#disposed) {
      throw new Error("Cannot replay a disposed Fragno outbox synchronizer.");
    }

    this.#caughtUp = false;
    await this.#runCatchUp();
  }

  stream(options: { onOpen(): void }): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(new Error("Cannot stream a disposed Fragno outbox synchronizer."));
    }
    if (!this.#caughtUp) {
      return Promise.reject(new Error("Cannot stream before Fragno outbox catch-up completes."));
    }

    if (!this.#streamPromise) {
      const streamPromise = this.#runStream(options);
      this.#streamPromise = streamPromise;
      void streamPromise.then(
        () => {
          if (this.#streamPromise === streamPromise) {
            this.#streamPromise = undefined;
          }
        },
        () => {
          if (this.#streamPromise === streamPromise) {
            this.#streamPromise = undefined;
          }
        },
      );
    }
    return this.#streamPromise;
  }

  applyChanges(targetKey: string, delivery: FragnoOutboxDelivery): void {
    this.#requireSubscriber(targetKey).apply(delivery);
  }

  truncate(targetKey: string): void {
    this.#requireSubscriber(targetKey).truncate();
  }

  markReady(): void {
    for (const subscriber of this.#subscribers.values()) {
      subscriber.markReady();
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.#abortController.abort();
    this.#subscribers.clear();
    const error = new Error("Fragno outbox synchronization was disposed before registration.");
    for (const waiter of this.#registrationWaiters) {
      waiter.reject(error);
    }
    this.#registrationWaiters.clear();
  }

  async #runCatchUp(): Promise<void> {
    if (this.#disposed) {
      throw new Error("Cannot catch up a disposed Fragno outbox synchronizer.");
    }

    await Promise.all(
      [...this.#subscribers.values()]
        .map((subscriber) => subscriber.prepareCatchUp?.())
        .filter((preparation): preparation is Promise<void> => preparation !== undefined),
    );

    let checkpoint = this.#checkpointStore.getCheckpoint();
    let afterVersionstamp = checkpoint
      ? outboxPageAfterVersionstamp(checkpoint.versionstamp)
      : undefined;
    let page = 0;

    while (!this.#abortController.signal.aborted) {
      page += 1;
      const entries = await this.#fetcher.listOutbox({
        afterVersionstamp,
        signal: this.#abortController.signal,
      });
      if (this.#abortController.signal.aborted) {
        throw new DOMException("Fragno outbox catch-up was aborted.", "AbortError");
      }
      assertOrderedOutboxPage(entries, afterVersionstamp);

      checkpoint = this.#applyAndAdvancePage(checkpoint, entries);
      this.#onCatchUpPage?.(checkpoint);

      if (entries.length < FRAGNO_OUTBOX_PAGE_SIZE) {
        this.markReady();
        this.#caughtUp = true;
        return;
      }

      afterVersionstamp = entries[entries.length - 1].versionstamp;
    }

    throw new DOMException("Fragno outbox catch-up was aborted.", "AbortError");
  }

  async #runStream(options: { onOpen(): void }): Promise<void> {
    const afterVersionstamp = this.#checkpointStore.getCheckpoint()?.versionstamp;
    const body = await this.#fetcher.openOutboxStream({
      afterVersionstamp,
      signal: this.#abortController.signal,
    });
    if (this.#disposed) {
      throw new DOMException("Fragno outbox streaming was aborted.", "AbortError");
    }

    options.onOpen();
    await consumeNdjsonOutboxStream(body, {
      signal: this.#abortController.signal,
      onEntry: (entry) => {
        const checkpoint = this.#checkpointStore.getCheckpoint();
        this.#applyAndAdvanceEntry(checkpoint, entry);
      },
    });

    if (this.#abortController.signal.aborted) {
      throw new DOMException("Fragno outbox streaming was aborted.", "AbortError");
    }
    throw new Error("Fragno outbox stream closed unexpectedly.");
  }

  #applyAndAdvancePage(
    checkpoint: FragnoOutboxCheckpoint | undefined,
    entries: readonly FragnoOutboxEntry[],
  ): FragnoOutboxCheckpoint | undefined {
    const deliveriesByTarget = new Map<string, FragnoOutboxDelivery[]>();
    let nextCheckpoint = checkpoint;

    for (const entry of entries) {
      if (!shouldApplyOutboxEntry(nextCheckpoint, entry)) {
        continue;
      }

      this.#planEntryDeliveries(entry, deliveriesByTarget);
      nextCheckpoint = checkpointForEntry(entry);
    }

    if (!nextCheckpoint || nextCheckpoint === checkpoint) {
      return checkpoint;
    }

    for (const [targetKey, deliveries] of deliveriesByTarget) {
      this.#requireSubscriber(targetKey).applyBatch(deliveries);
    }
    this.#checkpointStore.setCheckpoint(nextCheckpoint);
    return nextCheckpoint;
  }

  #applyAndAdvanceEntry(
    checkpoint: FragnoOutboxCheckpoint | undefined,
    entry: FragnoOutboxEntry,
  ): FragnoOutboxCheckpoint | undefined {
    if (!shouldApplyOutboxEntry(checkpoint, entry)) {
      return checkpoint;
    }

    this.#applyEntry(entry);

    // Each affected collection stores this entry identity atomically with its row changes. A retry
    // therefore skips collections that committed before a later collection failed.
    const nextCheckpoint = checkpointForEntry(entry);
    this.#checkpointStore.setCheckpoint(nextCheckpoint);
    return nextCheckpoint;
  }

  #applyEntry(entry: FragnoOutboxEntry): void {
    const deliveriesByTarget = new Map<string, FragnoOutboxDelivery[]>();
    this.#planEntryDeliveries(entry, deliveriesByTarget);

    for (const [targetKey, deliveries] of deliveriesByTarget) {
      this.#requireSubscriber(targetKey).apply(deliveries[0]);
    }
  }

  #planEntryDeliveries(
    entry: FragnoOutboxEntry,
    deliveriesByTarget: Map<string, FragnoOutboxDelivery[]>,
  ): void {
    const payload = decodeFragnoOutboxPayload(entry.payload);
    const operationsByTarget = new Map<string, OutboxOperation[]>();

    for (const operation of payload.operations) {
      const target = fragnoOutboxOperationTarget(operation);
      const targetKey = fragnoOutboxTargetKey(target.namespace, target.table);
      if (!this.#subscribers.has(targetKey)) {
        continue;
      }

      const targetOperations = operationsByTarget.get(targetKey);
      if (targetOperations) {
        targetOperations.push(operation);
      } else {
        operationsByTarget.set(targetKey, [operation]);
      }
    }

    for (const [targetKey, operations] of operationsByTarget) {
      const subscriber = this.#requireSubscriber(targetKey);
      const changes = projectFragnoOutboxOperations(entry, operations, {
        schema: subscriber.target.schema,
        table: subscriber.target.tableName,
        namespace: subscriber.target.namespace,
      });
      const deliveries = deliveriesByTarget.get(targetKey) ?? [];
      deliveries.push({
        checkpoint: checkpointForEntry(entry),
        changes: changes as FragnoCollectionChange<FragnoSynchronizedRow>[],
      });
      deliveriesByTarget.set(targetKey, deliveries);
    }
  }

  #requireSubscriber(targetKey: string): FragnoOutboxSubscriber {
    const subscriber = this.#subscribers.get(targetKey);
    if (!subscriber) {
      throw new Error(`No Fragno collection is registered for outbox target ${targetKey}.`);
    }
    return subscriber;
  }

  #hasEveryTarget(targets: readonly string[]): boolean {
    return targets.every((target) => this.#subscribers.has(target));
  }

  #resolveRegistrationWaiters(): void {
    for (const waiter of this.#registrationWaiters) {
      if (this.#hasEveryTarget(waiter.targets)) {
        this.#registrationWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  }
}

export function fragnoOutboxTargetKey(namespace: string, tableName: string): string {
  return `${identifierSegment(namespace)}${identifierSegment(tableName)}`;
}

function identifierSegment(value: string): string {
  return `${value.length}:${value}`;
}

function assertOrderedOutboxPage(
  entries: readonly FragnoOutboxEntry[],
  afterVersionstamp: string | undefined,
): void {
  let previousVersionstamp = afterVersionstamp;

  for (const entry of entries) {
    if (previousVersionstamp !== undefined && entry.versionstamp <= previousVersionstamp) {
      throw new Error(
        `Fragno outbox page is not strictly ordered after versionstamp ${previousVersionstamp}.`,
      );
    }
    previousVersionstamp = entry.versionstamp;
  }
}
