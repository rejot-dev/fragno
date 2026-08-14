import { createCollection, type Collection, type SyncConfig } from "@tanstack/db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";

import type { FragnoOutboxCheckpoint } from "../checkpoint";

export const FRAGNO_INTERNAL_COLLECTION_ID = "fragno.outbox.internal.v1";
export const FRAGNO_INTERNAL_STATUS_ID = "coordinator" as const;
export const FRAGNO_INTERNAL_CHECKPOINT_METADATA_KEY = "fragno.outbox.checkpoint.v1";
export const FRAGNO_INTERNAL_FLUSH_MARKER_METADATA_KEY = "fragno.outbox.flush-marker.v1";

export type FragnoOutboxCoordinatorState =
  | "opening"
  | "idle"
  | "registering"
  | "catching-up"
  | "caught-up"
  | "replaying"
  | "live"
  | "retrying"
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
    persistence: PersistedCollectionPersistence;
    schemaVersion?: number;
    state?: FragnoOutboxCoordinatorState;
  }) {
    const persistence = resolveCollectionPersistence(
      options.persistence,
      FRAGNO_INTERNAL_COLLECTION_ID,
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
        id: FRAGNO_INTERNAL_COLLECTION_ID,
        getKey: (row) => row.id,
        persistence,
        schemaVersion: options.schemaVersion,
        syncMode: "eager",
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
    this.#preloadPromise = this.collection.preload().then(() => {
      this.#publishStatus();
    });
    return this.#preloadPromise;
  }

  getCheckpoint(): FragnoOutboxCheckpoint | undefined {
    return this.#checkpoint;
  }

  setCheckpoint(checkpoint: FragnoOutboxCheckpoint): void {
    this.#checkpoint = checkpoint;
    this.#status = { ...this.#status, checkpoint };

    const controls = this.#requireControls();
    controls.begin();
    controls.metadata!.collection.set(FRAGNO_INTERNAL_CHECKPOINT_METADATA_KEY, checkpoint);
    controls.write({ type: "update", value: this.#status });
    controls.commit();
  }

  setFlushMarker(marker: string): void {
    const controls = this.#requireControls();
    controls.begin();
    controls.metadata!.collection.set(FRAGNO_INTERNAL_FLUSH_MARKER_METADATA_KEY, marker);
    controls.commit();
  }

  clearCheckpoint(): void {
    this.#checkpoint = undefined;
    this.#status = { ...this.#status, checkpoint: null };

    const controls = this.#requireControls();
    controls.begin();
    controls.metadata!.collection.delete(FRAGNO_INTERNAL_CHECKPOINT_METADATA_KEY);
    controls.write({ type: "update", value: this.#status });
    controls.commit();
  }

  setState(state: FragnoOutboxCoordinatorState, error: unknown = null): void {
    this.#status = {
      ...this.#status,
      state,
      error: state === "failed" ? coordinatorError(error) : null,
    };
    this.#publishStatus();
  }

  cleanup(): Promise<void> {
    return this.collection.cleanup().then(() => {});
  }

  #publishStatus(): void {
    const controls = this.#requireControls();
    controls.begin();
    controls.write({ type: "update", value: this.#status });
    controls.commit();
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
