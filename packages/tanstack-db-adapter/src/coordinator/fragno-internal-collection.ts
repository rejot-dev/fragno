import {
  createCollection,
  type Collection,
  type SyncAppliedReceipt,
  type SyncConfig,
} from "@tanstack/db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";

import type { FragnoOutboxCheckpoint } from "../checkpoint";

export const FRAGNO_INTERNAL_STATUS_ID = "coordinator" as const;
export const FRAGNO_INTERNAL_CHECKPOINT_METADATA_KEY = "fragno.outbox.checkpoint.v1";
const FRAGNO_INTERNAL_FLUSH_MARKER_METADATA_KEY = "fragno.outbox.flush-marker.v1";

export type FragnoOutboxCoordinatorState =
  | "opening"
  | "idle"
  | "registering"
  | "catching-up"
  | "replaying"
  | "live"
  | "retrying"
  | "rotating"
  | "failed"
  | "disposed";

export type FragnoOutboxCoordinatorError = {
  name: string;
  message: string;
};

export type FragnoInternalRow = {
  id: typeof FRAGNO_INTERNAL_STATUS_ID;
  state: FragnoOutboxCoordinatorState;
  checkpoint: FragnoOutboxCheckpoint | null;
  error: FragnoOutboxCoordinatorError | null;
};

type FragnoInternalSyncControls = Parameters<SyncConfig<FragnoInternalRow, string>["sync"]>[0];

/** Persisted and user-queryable coordinator state for one Fragno outbox database. */
export class FragnoInternalCollection {
  readonly collection: Collection<FragnoInternalRow, string>;

  #controls: FragnoInternalSyncControls | undefined;
  #preloadPromise: Promise<void> | undefined;
  #checkpoint: FragnoOutboxCheckpoint | undefined;
  #status: FragnoInternalRow;

  constructor(options: {
    databaseKey: string;
    persistence: PersistedCollectionPersistence;
    schemaVersion?: number;
    state?: FragnoOutboxCoordinatorState;
  }) {
    // Every coordinator has the same internal table, and TanStack identifies live-query sources
    // by collection ID, so the ID names this coordinator's local database.
    const id = `fragno.outbox.internal.v2:${options.databaseKey}`;
    const persistence = resolveCollectionPersistence(
      options.persistence,
      id,
      options.schemaVersion,
    );
    this.#status = {
      id: FRAGNO_INTERNAL_STATUS_ID,
      state: options.state ?? "opening",
      checkpoint: null,
      error: null,
    };

    this.collection = createCollection(
      persistedCollectionOptions<FragnoInternalRow, string>({
        id,
        getKey: (row) => row.id,
        persistence,
        schemaVersion: options.schemaVersion,
        syncMode: "eager",
        // The coordinator writes through these sync controls for as long as it runs, usually with
        // no subscriber; collecting the idle collection would drop them and stop synchronization.
        gcTime: 0,
        sync: {
          rowUpdateMode: "full",
          sync: (controls) => {
            if (!controls.metadata) {
              throw new Error("Fragno internal collection requires TanStack sync metadata.");
            }

            this.#controls = controls;
            this.#checkpoint = controls.metadata.collection.get(
              FRAGNO_INTERNAL_CHECKPOINT_METADATA_KEY,
            ) as FragnoOutboxCheckpoint | undefined;
            this.#status = {
              ...this.#status,
              checkpoint: this.#checkpoint ?? null,
            };
            controls.markReady();

            return () => {
              if (this.#controls === controls) {
                this.#controls = undefined;
              }
            };
          },
        },
      }),
    );
  }

  preload(): Promise<void> {
    if (this.#preloadPromise) {
      return this.#preloadPromise;
    }
    this.#preloadPromise = this.collection.preload().then(async () => {
      await this.#publishStatus();
    });
    return this.#preloadPromise;
  }

  getCheckpoint(): FragnoOutboxCheckpoint | undefined {
    return this.#checkpoint;
  }

  setCheckpoint(checkpoint: FragnoOutboxCheckpoint): SyncAppliedReceipt {
    this.#checkpoint = checkpoint;
    this.#status = { ...this.#status, checkpoint };

    const controls = this.#requireControls();
    controls.begin();
    controls.metadata!.collection.set(FRAGNO_INTERNAL_CHECKPOINT_METADATA_KEY, checkpoint);
    controls.write({ type: "update", value: this.#status });
    return controls.commit();
  }

  /**
   * Settles once every earlier write in the shared persistence database is durable: a persisted
   * commit's receipt settles with its durable write, and writes persist in order.
   */
  flushPersistence(): SyncAppliedReceipt {
    const controls = this.#requireControls();
    controls.begin();
    // A fresh marker gives the commit a change to persist.
    controls.metadata!.collection.set(
      FRAGNO_INTERNAL_FLUSH_MARKER_METADATA_KEY,
      globalThis.crypto.randomUUID(),
    );
    return controls.commit();
  }

  clearCheckpoint(): SyncAppliedReceipt {
    this.#checkpoint = undefined;
    this.#status = { ...this.#status, checkpoint: null };

    const controls = this.#requireControls();
    controls.begin();
    controls.metadata!.collection.delete(FRAGNO_INTERNAL_CHECKPOINT_METADATA_KEY);
    controls.write({ type: "update", value: this.#status });
    return controls.commit();
  }

  setState(state: FragnoOutboxCoordinatorState, error: unknown = null): SyncAppliedReceipt {
    this.#status = {
      ...this.#status,
      state,
      error: state === "failed" ? coordinatorError(error) : null,
    };
    return this.#publishStatus();
  }

  cleanup(): Promise<void> {
    return this.collection.cleanup().then(() => {});
  }

  #publishStatus(): SyncAppliedReceipt {
    const controls = this.#requireControls();
    controls.begin();
    controls.write({ type: "update", value: this.#status });
    return controls.commit();
  }

  #requireControls(): FragnoInternalSyncControls {
    if (!this.#controls) {
      throw new Error("Fragno internal collection has not been preloaded.");
    }
    return this.#controls;
  }
}

function coordinatorError(error: unknown): FragnoOutboxCoordinatorError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { name: "Error", message: String(error) };
}

function resolveCollectionPersistence(
  persistence: PersistedCollectionPersistence,
  collectionId: string,
  schemaVersion: number | undefined,
): PersistedCollectionPersistence {
  return (
    persistence.resolvePersistenceForCollection?.({
      collectionId,
      mode: "sync-present",
      schemaVersion,
    }) ??
    persistence.resolvePersistenceForMode?.("sync-present") ??
    persistence
  );
}
