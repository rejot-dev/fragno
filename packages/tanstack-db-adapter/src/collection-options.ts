import { resolveDatabaseNamespace } from "@fragno-dev/db/database-namespace";
import type { AnySchema } from "@fragno-dev/db/schema";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  BTreeIndex,
  createCollection,
  type BaseCollectionConfig,
  type Collection,
  type CollectionConfig,
  type InferSchemaInput,
  type UtilsRecord,
} from "@tanstack/db";

import { applyFragnoOutboxEntry, type FragnoOutboxApplyControls } from "./apply-entry";
import {
  FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY,
  FRAGNO_OUTBOX_INITIALIZED_METADATA_KEY,
  FRAGNO_OUTBOX_SOURCE_METADATA_KEY,
  shouldApplyOutboxEntry,
  type FragnoOutboxCheckpoint,
  type FragnoOutboxSource,
} from "./checkpoint";
import type { FragnoOutboxConsumer, FragnoOutboxCoordinator } from "./coordinator";
import type { FragnoCollectionRow, FragnoCollectionTarget } from "./protocol";

export type FragnoCollectionSyncStatus = "idle" | "loading" | "ready" | "error";

export type FragnoCollectionUtils = {
  getSyncStatus(): FragnoCollectionSyncStatus;
  getLastError(): unknown;
  initialSync(): Promise<void>;
  syncOnce(): Promise<void>;
  getCheckpoint(): FragnoOutboxCheckpoint | undefined;
};

export type FragnoTableName<TSchema extends AnySchema> = keyof TSchema["tables"] & string;

type FragnoCollectionBehavior<
  TRow extends object,
  TStandardSchema extends StandardSchemaV1,
  TUtils extends UtilsRecord,
> = Omit<
  BaseCollectionConfig<TRow, string, TStandardSchema, TUtils>,
  "id" | "getKey" | "sync" | "syncMode" | "onInsert" | "onUpdate" | "onDelete" | "utils"
>;

export type FragnoCollectionOptions<
  TSchema extends AnySchema,
  TTableName extends FragnoTableName<TSchema>,
  TStandardSchema extends StandardSchemaV1 = never,
  TUtils extends UtilsRecord = UtilsRecord,
> = FragnoCollectionBehavior<
  FragnoCollectionRow<TSchema["tables"][TTableName]>,
  TStandardSchema,
  TUtils
> & {
  /** Stable identity used by TanStack collection persistence and coordinator registration. */
  id: string;
  /** Shared synchronization owner for every collection reading the same Fragno outbox. */
  coordinator: FragnoOutboxCoordinator;
  target: FragnoCollectionTarget<TSchema, TTableName>;
  utils?: TUtils;
};

type FragnoCollectionInput<TRow extends object, TStandardSchema extends StandardSchemaV1> = [
  TStandardSchema,
] extends [never]
  ? TRow
  : InferSchemaInput<TStandardSchema>;

export type FragnoCollection<
  TSchema extends AnySchema,
  TTableName extends FragnoTableName<TSchema>,
  TStandardSchema extends StandardSchemaV1 = never,
  TUtils extends UtilsRecord = UtilsRecord,
> = Collection<
  FragnoCollectionRow<TSchema["tables"][TTableName]>,
  string,
  TUtils & FragnoCollectionUtils,
  TStandardSchema,
  FragnoCollectionInput<FragnoCollectionRow<TSchema["tables"][TTableName]>, TStandardSchema>
>;

export type FragnoCollectionFactory = <
  TSchema extends AnySchema,
  TTableName extends FragnoTableName<TSchema>,
  TStandardSchema extends StandardSchemaV1 = never,
  TUtils extends UtilsRecord = UtilsRecord,
>(
  options: FragnoCollectionOptions<TSchema, TTableName, TStandardSchema, TUtils>,
) => FragnoCollection<TSchema, TTableName, TStandardSchema, TUtils>;

export type FragnoCollectionConfig<
  TSchema extends AnySchema,
  TTableName extends FragnoTableName<TSchema>,
  TStandardSchema extends StandardSchemaV1 = never,
  TUtils extends UtilsRecord = UtilsRecord,
> = CollectionConfig<
  FragnoCollectionRow<TSchema["tables"][TTableName]>,
  string,
  TStandardSchema,
  TUtils & FragnoCollectionUtils
>;

export function createFragnoCollection<
  TSchema extends AnySchema,
  TTableName extends FragnoTableName<TSchema>,
  TStandardSchema extends StandardSchemaV1 = never,
  TUtils extends UtilsRecord = UtilsRecord,
>(
  options: FragnoCollectionOptions<TSchema, TTableName, TStandardSchema, TUtils>,
): FragnoCollection<TSchema, TTableName, TStandardSchema, TUtils> {
  type Row = FragnoCollectionRow<TSchema["tables"][TTableName]>;
  type CollectionUtils = TUtils & FragnoCollectionUtils;

  const sourceOptions = fragnoCollectionOptions(options);
  // TanStack's createCollection overload widens a generic Standard Schema. The source options
  // preserve the row, schema, and utility contracts, so establish them once at this adapter boundary.
  const collectionOptions = sourceOptions as unknown as CollectionConfig<
    Row,
    string,
    never,
    CollectionUtils
  >;

  return createCollection(collectionOptions) as FragnoCollection<
    TSchema,
    TTableName,
    TStandardSchema,
    TUtils
  >;
}

export function fragnoCollectionOptions<
  TSchema extends AnySchema,
  TTableName extends FragnoTableName<TSchema>,
  TStandardSchema extends StandardSchemaV1 = never,
  TUtils extends UtilsRecord = UtilsRecord,
>(
  options: FragnoCollectionOptions<TSchema, TTableName, TStandardSchema, TUtils>,
): FragnoCollectionConfig<TSchema, TTableName, TStandardSchema, TUtils> {
  type Row = FragnoCollectionRow<TSchema["tables"][TTableName]>;

  const { id, coordinator, target, utils, ...collectionBehavior } = options;
  const idColumnName = target.schema.tables[target.table].getIdColumn().name as keyof Row;
  const rowMetadataKey = "fragno.outbox.rows.v1";

  let checkpoint: FragnoOutboxCheckpoint | undefined;
  let source: FragnoOutboxSource | undefined;
  let initialized = false;
  let syncStatus: FragnoCollectionSyncStatus = "idle";
  let lastError: unknown;
  let syncOnce: () => Promise<void> = async () => {
    throw new Error(`Collection ${id} has not started syncing.`);
  };
  let resolveInitialSync!: () => void;
  let rejectInitialSync!: (error: unknown) => void;
  let initialSyncSettled = false;
  const initialSync = new Promise<void>((resolve, reject) => {
    resolveInitialSync = resolve;
    rejectInitialSync = reject;
  });
  void initialSync.catch(() => {});

  const collectionUtils = {
    ...utils,
    getSyncStatus: () => syncStatus,
    getLastError: () => lastError,
    initialSync: () => initialSync,
    syncOnce: () => syncOnce(),
    getCheckpoint: () => checkpoint,
  } as unknown as TUtils & FragnoCollectionUtils;

  return {
    ...collectionBehavior,
    autoIndex: collectionBehavior.autoIndex ?? "eager",
    defaultIndexType: collectionBehavior.defaultIndexType ?? BTreeIndex,
    id,
    getKey: (row) => row[idColumnName] as string,
    syncMode: "eager",
    sync: {
      rowUpdateMode: "partial",
      sync(controls) {
        if (!controls.metadata) {
          throw new Error("Fragno outbox ingestion requires TanStack sync metadata.");
        }

        const metadata = controls.metadata;
        checkpoint = metadata.collection.get(FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY) as
          | FragnoOutboxCheckpoint
          | undefined;
        source = metadata.collection.get(FRAGNO_OUTBOX_SOURCE_METADATA_KEY) as
          | FragnoOutboxSource
          | undefined;
        initialized = metadata.collection.get(FRAGNO_OUTBOX_INITIALIZED_METADATA_KEY) === true;

        let materializedRows =
          (metadata.collection.get(rowMetadataKey) as Record<string, Row> | undefined) ?? {};
        const persistMaterializedRows = () => {
          metadata.collection.set(rowMetadataKey, materializedRows);
        };
        const applyControls = {
          begin: controls.begin,
          write(message) {
            controls.write(message);
            if (message.type === "delete" && "key" in message) {
              const key = message.key as string;
              const { [key]: _removed, ...remaining } = materializedRows;
              materializedRows = remaining;
            } else {
              const row = message.value;
              const key = row[idColumnName] as string;
              materializedRows = {
                ...materializedRows,
                [key]: message.type === "update" ? { ...materializedRows[key], ...row } : row,
              };
            }
            persistMaterializedRows();
          },
          deleteMatching(match, rowMetadata) {
            for (const [key, row] of Object.entries(materializedRows)) {
              if (
                !Object.entries(match).every(([field, value]) => row[field as keyof Row] === value)
              ) {
                continue;
              }
              controls.write({ type: "delete", key, metadata: rowMetadata });
              const { [key]: _removed, ...remaining } = materializedRows;
              materializedRows = remaining;
            }
            persistMaterializedRows();
          },
          metadata,
          commit: controls.commit,
        } satisfies FragnoOutboxApplyControls<Row>;
        let ready = false;

        const consumer: FragnoOutboxConsumer = {
          id,
          getCheckpoint: () => checkpoint,
          isInitialized: () => initialized,
          prepareSource(adapterIdentity) {
            const nextSource = {
              adapterIdentity,
              namespace: resolveDatabaseNamespace(target.schema.name, target.namespace) ?? "",
              table: target.table,
            } satisfies FragnoOutboxSource;
            if (
              source?.adapterIdentity !== nextSource.adapterIdentity ||
              source.namespace !== nextSource.namespace ||
              source.table !== nextSource.table
            ) {
              controls.begin();
              controls.truncate();
              metadata.collection.delete(FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY);
              metadata.collection.delete(FRAGNO_OUTBOX_INITIALIZED_METADATA_KEY);
              metadata.collection.set(FRAGNO_OUTBOX_SOURCE_METADATA_KEY, nextSource);
              controls.commit();
              source = nextSource;
              checkpoint = undefined;
              initialized = false;
            }
          },
          applyEntry(entry) {
            if (!shouldApplyOutboxEntry(checkpoint, entry)) {
              return;
            }

            checkpoint = applyFragnoOutboxEntry(entry, target, applyControls);
          },
          markLoading() {
            syncStatus = "loading";
          },
          markReady() {
            if (!initialized) {
              controls.begin();
              metadata.collection.set(FRAGNO_OUTBOX_INITIALIZED_METADATA_KEY, true);
              controls.commit();
              initialized = true;
            }

            syncStatus = "ready";
            lastError = undefined;
            if (!ready) {
              controls.markReady();
              ready = true;
            }
            if (!initialSyncSettled) {
              initialSyncSettled = true;
              resolveInitialSync();
            }
          },
          markError(error) {
            syncStatus = "error";
            lastError = error;
            if (!initialSyncSettled) {
              initialSyncSettled = true;
              rejectInitialSync(error);
            }
          },
        };
        let unregisterConsumer: (() => void) | undefined;

        const registerConsumer = () => {
          unregisterConsumer ??= coordinator.register(consumer);
        };
        const unregisterConsumerWhenInactive = () => {
          if (controls.collection.subscriberCount === 0) {
            unregisterConsumer?.();
            unregisterConsumer = undefined;
          }
        };
        const unsubscribeFromSubscriberChanges = controls.collection.on(
          "subscribers:change",
          ({ subscriberCount }) => {
            if (subscriberCount === 0) {
              unregisterConsumerWhenInactive();
            } else {
              registerConsumer();
            }
          },
        );

        registerConsumer();
        syncOnce = async () => {
          const wasRegistered = unregisterConsumer !== undefined;
          registerConsumer();
          try {
            await coordinator.syncOnce();
          } finally {
            if (!wasRegistered) {
              unregisterConsumerWhenInactive();
            }
          }
        };

        return () => {
          unsubscribeFromSubscriberChanges();
          unregisterConsumer?.();
          unregisterConsumer = undefined;
        };
      },
    },
    utils: collectionUtils,
  };
}
