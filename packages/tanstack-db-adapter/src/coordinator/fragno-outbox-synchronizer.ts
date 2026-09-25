import { FRAGNO_OUTBOX_PAGE_SIZE } from "@fragno-dev/db/outbox";
import type { AnySchema } from "@fragno-dev/db/schema";

import type { OutboxOperation } from "@fragno-dev/db";

import {
  checkpointForEntry,
  outboxStreamResumeCursor,
  shouldApplyOutboxEntry,
  type FragnoOutboxCheckpoint,
} from "../checkpoint";
import { consumeNdjsonOutboxStream, FragnoOutboxProtocolError } from "../outbox-stream";
import {
  decodeFragnoOutboxPayload,
  fragnoOutboxOperationTarget,
  projectFragnoOutboxOperations,
  type FragnoCollectionChange,
  type FragnoOutboxEntry,
} from "../protocol";
type FragnoSynchronizedRow = Record<string, unknown>;

type FragnoOutboxFetcher = {
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

  #sessionPromise: Promise<void> | undefined;
  readonly #adapterIdentity: string;
  #ready = false;
  #disposed = false;

  readonly #onCatchUpPage?: (checkpoint: FragnoOutboxCheckpoint | undefined) => void;

  constructor(options: {
    fetcher: FragnoOutboxFetcher;
    adapterIdentity: string;
    checkpointStore: FragnoOutboxCheckpointStore;
    onCatchUpPage?: (checkpoint: FragnoOutboxCheckpoint | undefined) => void;
  }) {
    this.#fetcher = options.fetcher;
    this.#adapterIdentity = options.adapterIdentity;
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

  /** Runs catch-up and live delivery on one response; resolves only on planned rotation. */
  streamSession(options: {
    onStarted(targetVersionstamp: string | null): void;
    onCaughtUp(): void;
  }): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(
        new DOMException("Fragno outbox synchronization was disposed.", "AbortError"),
      );
    }
    this.#sessionPromise ??= this.#runStreamSession(options).finally(() => {
      this.#sessionPromise = undefined;
    });
    return this.#sessionPromise;
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

  async #runStreamSession(options: {
    onStarted(targetVersionstamp: string | null): void;
    onCaughtUp(): void;
  }): Promise<void> {
    if (this.#disposed) {
      throw new Error("Cannot catch up a disposed Fragno outbox synchronizer.");
    }

    await Promise.all(
      [...this.#subscribers.values()]
        .map((subscriber) => subscriber.prepareCatchUp?.())
        .filter((preparation): preparation is Promise<void> => preparation !== undefined),
    );

    const initialCheckpoint = this.#checkpointStore.getCheckpoint();
    const afterVersionstamp = outboxStreamResumeCursor(initialCheckpoint?.versionstamp);
    let checkpointVerified = initialCheckpoint === undefined;
    let caughtUp = false;
    let entries: FragnoOutboxEntry[] = [];
    let completedBatches = 0;
    const flushCatchUpBatch = () => {
      this.#applyAndAdvancePage(this.#checkpointStore.getCheckpoint(), entries);
      entries = [];
      completedBatches += 1;
      this.#onCatchUpPage?.(this.#checkpointStore.getCheckpoint());
    };
    const body = await this.#fetcher.openOutboxStream({
      afterVersionstamp,
      signal: this.#abortController.signal,
    });
    await consumeNdjsonOutboxStream(body, {
      signal: this.#abortController.signal,
      afterVersionstamp,
      onFrame: (frame) => {
        switch (frame.type) {
          case "started":
            if (frame.adapterIdentity !== this.#adapterIdentity) {
              throw new FragnoOutboxProtocolError(
                "Fragno outbox adapter identity changed during synchronization.",
              );
            }
            if (
              initialCheckpoint &&
              (frame.catchUpTargetVersionstamp === null ||
                frame.catchUpTargetVersionstamp < initialCheckpoint.versionstamp)
            ) {
              throw new FragnoOutboxProtocolError(
                "Fragno outbox source is behind the persisted checkpoint.",
              );
            }
            options.onStarted(frame.catchUpTargetVersionstamp);
            break;
          case "entry":
            if (!checkpointVerified && initialCheckpoint) {
              try {
                shouldApplyOutboxEntry(initialCheckpoint, frame.entry);
              } catch (cause) {
                throw new FragnoOutboxProtocolError(
                  cause instanceof Error ? cause.message : "Fragno outbox checkpoint conflict.",
                  { cause },
                );
              }
              if (frame.entry.versionstamp === initialCheckpoint.versionstamp) {
                checkpointVerified = true;
              } else if (frame.entry.versionstamp > initialCheckpoint.versionstamp) {
                throw new FragnoOutboxProtocolError(
                  "Fragno outbox persisted checkpoint is missing from replay.",
                );
              }
            }
            if (caughtUp) {
              this.#applyAndAdvanceEntry(this.#checkpointStore.getCheckpoint(), frame.entry);
            } else {
              entries.push(frame.entry);
              if (entries.length === FRAGNO_OUTBOX_PAGE_SIZE) {
                flushCatchUpBatch();
              }
            }
            break;
          case "caught-up":
            if (!checkpointVerified) {
              throw new FragnoOutboxProtocolError(
                "Fragno outbox persisted checkpoint was not verified.",
              );
            }
            if (entries.length > 0 || completedBatches === 0) {
              flushCatchUpBatch();
            }
            caughtUp = true;
            if (!this.#ready) {
              this.markReady();
              this.#ready = true;
            }
            options.onCaughtUp();
            break;
          case "rotate":
            // A planned boundary is safe to commit; an interrupted partial batch is discarded.
            if (!caughtUp && entries.length > 0) {
              flushCatchUpBatch();
            }
            break;
          case "heartbeat":
            break;
        }
      },
    });
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
