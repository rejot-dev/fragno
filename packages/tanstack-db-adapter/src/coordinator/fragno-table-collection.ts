import {
  BTreeIndex,
  createCollection,
  type Collection,
  type SyncAppliedReceipt,
  type SyncConfig,
} from "@tanstack/db";
import {
  eagerStorageTarget,
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

            // A new registration owns a fresh key index; rotating its transport does not.
            let presentKeys: Set<string> | undefined;
            let preparation: Promise<void> | undefined;
            return options.outbox.register({
              target: options.target,
              ...(options.skipMissingTruncateDeletes
                ? {
                    prepareCatchUp() {
                      preparation ??= (async () => {
                        if (!persistence.adapter.scanRows) {
                          throw new Error(
                            `Persistence for ${options.id} cannot retrieve keys required to skip missing truncate deletes.`,
                          );
                        }
                        const persistedRows = await persistence.adapter.scanRows(
                          eagerStorageTarget(options.id),
                        );
                        presentKeys = new Set(persistedRows.map(({ key }) => String(key)));
                      })();
                      return preparation;
                    },
                  }
                : {}),
              apply(delivery) {
                return applyDeliveries(controls, [delivery], presentKeys, "live");
              },
              applyBatch(deliveries) {
                return applyDeliveries(controls, deliveries, presentKeys, "catch-up");
              },
              truncate() {
                controls.begin();
                controls.truncate();
                const visible = controls.commit();
                presentKeys?.clear();
                return visible;
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
  presentKeys: Set<string> | undefined,
  deliveryMode: "live" | "catch-up",
): SyncAppliedReceipt {
  let appliedCheckpoint = controls.metadata!.collection.get(
    FRAGNO_OUTBOX_COLLECTION_CHECKPOINT_METADATA_KEY,
  ) as FragnoOutboxCheckpoint | undefined;
  let nextCheckpoint: FragnoOutboxCheckpoint | undefined;
  // Stage only touched keys, not a copy of the whole index. Failed writes/commits must not
  // advance it, while later changes in the same batch must see earlier inserts and deletes.
  const keyChanges = new Map<string, boolean>();

  controls.begin();
  for (const { checkpoint, changes } of deliveries) {
    if (!shouldApplyOutboxCheckpoint(appliedCheckpoint, checkpoint)) {
      continue;
    }

    for (const change of changes) {
      if (
        deliveryMode === "catch-up" &&
        change.type === "delete" &&
        change.origin === "truncate" &&
        presentKeys &&
        !(keyChanges.get(change.key) ?? presentKeys.has(change.key))
      ) {
        continue;
      }

      controls.write(toTanStackChangeMessage(change));
      if (presentKeys) {
        keyChanges.set(change.key, change.type !== "delete");
      }
    }
    appliedCheckpoint = checkpoint;
    nextCheckpoint = checkpoint;
  }

  if (!nextCheckpoint) {
    return controls.commit();
  }

  controls.metadata!.collection.set(
    FRAGNO_OUTBOX_COLLECTION_CHECKPOINT_METADATA_KEY,
    nextCheckpoint,
  );
  const visible = controls.commit();
  if (presentKeys) {
    for (const [key, present] of keyChanges) {
      if (present) {
        presentKeys.add(key);
      } else {
        presentKeys.delete(key);
      }
    }
  }
  return visible;
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
