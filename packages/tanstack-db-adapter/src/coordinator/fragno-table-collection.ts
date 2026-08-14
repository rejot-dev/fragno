import { BTreeIndex, createCollection, type Collection, type SyncConfig } from "@tanstack/db";
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/db-sqlite-persistence-core";

import {
  FRAGNO_OUTBOX_COLLECTION_CHECKPOINT_METADATA_KEY,
  shouldApplyOutboxCheckpoint,
  type FragnoOutboxCheckpoint,
} from "../checkpoint";
import { toTanStackChangeMessage } from "../protocol";
import type {
  FragnoOutboxDelivery,
  FragnoOutboxSynchronizer,
  FragnoOutboxTarget,
} from "./fragno-outbox-synchronizer";

type FragnoTableRow = Record<string, unknown>;
type FragnoTableSyncControls = Parameters<SyncConfig<FragnoTableRow, string>["sync"]>[0];

/** One lazily registered TanStack collection backed by the shared Fragno persistence database. */
export class FragnoTableCollection {
  readonly collection: Collection<FragnoTableRow, string>;

  constructor(options: {
    id: string;
    idColumnName: string;
    persistence: PersistedCollectionPersistence;
    schemaVersion: number;
    outbox: FragnoOutboxSynchronizer;
    rowUpdateMode: "partial" | "full";
    skipMissingTruncateDeletes: boolean;
    target: FragnoOutboxTarget;
  }) {
    const persistence = resolveCollectionPersistence(
      options.persistence,
      options.id,
      options.schemaVersion,
    );
    let catchUpPresentKeys: Set<string> | undefined;

    this.collection = createCollection(
      persistedCollectionOptions<FragnoTableRow, string>({
        id: options.id,
        getKey: (row) => row[options.idColumnName] as string,
        persistence,
        schemaVersion: options.schemaVersion,
        syncMode: "eager",
        gcTime: 0,
        autoIndex: "eager",
        defaultIndexType: BTreeIndex,
        sync: {
          rowUpdateMode: options.rowUpdateMode,
          sync: (controls) => {
            if (!controls.metadata) {
              throw new Error("Fragno table collections require TanStack sync metadata.");
            }

            return options.outbox.register({
              target: options.target,
              ...(options.skipMissingTruncateDeletes
                ? {
                    async prepareCatchUp() {
                      if (!persistence.adapter.scanRows) {
                        throw new Error(
                          `Persistence for ${options.id} cannot retrieve keys required to skip missing truncate deletes.`,
                        );
                      }
                      const persistedRows = await persistence.adapter.scanRows(options.id);
                      catchUpPresentKeys = new Set(persistedRows.map(({ key }) => String(key)));
                    },
                  }
                : {}),
              apply(delivery) {
                applyDeliveries(controls, [delivery]);
              },
              applyBatch(deliveries) {
                applyDeliveries(controls, deliveries, catchUpPresentKeys);
              },
              truncate() {
                controls.begin();
                controls.truncate();
                controls.commit();
              },
              markReady() {
                controls.markReady();
              },
            });
          },
        },
      }),
    );
  }
}

function applyDeliveries(
  controls: FragnoTableSyncControls,
  deliveries: readonly FragnoOutboxDelivery[],
  catchUpPresentKeys?: Set<string>,
): void {
  let appliedCheckpoint = controls.metadata!.collection.get(
    FRAGNO_OUTBOX_COLLECTION_CHECKPOINT_METADATA_KEY,
  ) as FragnoOutboxCheckpoint | undefined;
  let nextCheckpoint: FragnoOutboxCheckpoint | undefined;

  controls.begin();
  for (const { checkpoint, changes } of deliveries) {
    if (!shouldApplyOutboxCheckpoint(appliedCheckpoint, checkpoint)) {
      continue;
    }

    for (const change of changes) {
      if (
        change.type === "delete" &&
        change.origin === "truncate" &&
        catchUpPresentKeys &&
        !catchUpPresentKeys.has(change.key)
      ) {
        continue;
      }

      controls.write(toTanStackChangeMessage(change));
      if (catchUpPresentKeys) {
        if (change.type === "delete") {
          catchUpPresentKeys.delete(change.key);
        } else {
          catchUpPresentKeys.add(change.key);
        }
      }
    }
    appliedCheckpoint = checkpoint;
    nextCheckpoint = checkpoint;
  }

  if (!nextCheckpoint) {
    controls.commit();
    return;
  }

  controls.metadata!.collection.set(
    FRAGNO_OUTBOX_COLLECTION_CHECKPOINT_METADATA_KEY,
    nextCheckpoint,
  );
  controls.commit();
}

function resolveCollectionPersistence(
  persistence: PersistedCollectionPersistence,
  collectionId: string,
  schemaVersion: number,
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
