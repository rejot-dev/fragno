import type { AnySchema, AnyTable } from "@fragno-dev/db/schema";

import {
  createCollection,
  createLiveQueryCollection,
  eq,
  type Collection,
  type SyncConfig,
  type SyncMetadataApi,
} from "@tanstack/db";
import {
  persistedCollectionOptions,
  type PersistedCollectionCoordinator,
  type PersistedCollectionPersistence,
  type PersistedTx,
} from "@tanstack/db-sqlite-persistence-core";

import type { MaterializationPlan as StateMaterializationPlan } from "../materialization/plan-state-batch";
import {
  PersistenceWriteTracker,
  trackPersistenceWrites,
} from "../persistence/persistence-tracker";

export type FragnoStreamTableGroup<TSchema extends AnySchema = AnySchema> = {
  schema: TSchema;
  namespace?: string | null;
};

export type FragnoStreamDBPersistence = {
  provider: PersistedCollectionPersistence;
  scope: string;
  version: number;
};

export type StreamCheckpoint = {
  offset: string;
  cacheVersion: number;
  ownerId: string;
  generation: string;
  upToDate: boolean;
};

export type StreamSourceRow = {
  id: string;
  tableKey: string;
  externalId: string;
  row: Record<string, unknown>;
  checkpoint: StreamCheckpoint | null;
};

type SyncWrite = Parameters<SyncConfig<StreamSourceRow, string>["sync"]>[0]["write"];
export type SyncMessage = Parameters<SyncWrite>[0];
export type SourceCollectionChanges = Parameters<
  Parameters<Collection<StreamSourceRow, string>["subscribeChanges"]>[0]
>[0];

export type SourceSyncHandler = {
  begin: () => void;
  write: SyncWrite;
  commit: () => void;
  truncate: () => void;
  markReady: () => void;
  metadata?: SyncMetadataApi<string>;
};

export type SourceCollectionActivationBridge = {
  attach(activate: (handler: SourceSyncHandler) => void): void;
  activate(handler: SourceSyncHandler): void;
};

export type RegisteredTable = {
  table: AnyTable;
  key: string;
  collection: Collection<Record<string, unknown>, string>;
  preloadCollection: () => Promise<void>;
};

export type CollectionRegistry = {
  tables: Map<string, RegisteredTable>;
  sourceCollectionId: string;
  sourceCollection: Collection<StreamSourceRow, string>;
  sourceHandlerReady: Promise<void>;
  getSourceHandler: () => SourceSyncHandler | undefined;
  materializedRows: Map<string, StreamSourceRow>;
  persistence?: PersistedCollectionPersistence;
  persistenceWrites?: PersistenceWriteTracker;
  coordinator?: PersistedCollectionCoordinator;
};

export type PlannedTableChanges = {
  table: RegisteredTable;
  rows: Map<string, Record<string, unknown> | null>;
};

export type MaterializationPlan = {
  writes: SyncMessage[];
  tableChanges: Map<RegisteredTable, PlannedTableChanges>;
  reset?: boolean;
  txids?: readonly string[];
};

export const CHECKPOINT_SOURCE_ID = "fragno:checkpoint";
export const CHECKPOINT_TABLE_KEY = "fragno:<checkpoint>";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(typeof value === "string" ? value : String(value));

export const normalizeTableGroupNamespace = (group: FragnoStreamTableGroup): string | null =>
  group.namespace === undefined ? group.schema.name : group.namespace;

export const collectionKey = (
  schema: AnySchema,
  namespace: string | null,
  tableName: string,
): string => `${schema.name}:${namespace ?? "<null>"}:${tableName}`;

const createTableGroupIdentity = (groups: readonly FragnoStreamTableGroup[]): string => {
  const serializedGroups = groups.map((group) =>
    JSON.stringify({
      schema: group.schema.name,
      namespace: normalizeTableGroupNamespace(group),
      tables: Object.keys(group.schema.tables).sort(),
    }),
  );
  return `[${serializedGroups.sort().join(",")}]`;
};

export const sourceRowId = (tableKey: string, externalId: string): string =>
  JSON.stringify([tableKey, externalId]);

export function createSourceCollectionActivationBridge(): SourceCollectionActivationBridge {
  let activateSource: ((handler: SourceSyncHandler) => void) | undefined;

  return {
    attach(activate) {
      if (activateSource) {
        throw new Error("Fragno source collection activation is already attached.");
      }
      activateSource = activate;
    },
    activate(handler) {
      if (!activateSource) {
        throw new Error("Fragno source collection activated before its stream was attached.");
      }
      activateSource(handler);
    },
  };
}

const assertUniqueTableGroups = (groups: readonly FragnoStreamTableGroup[]): void => {
  const registeredTableKeys = new Set<string>();

  for (const group of groups) {
    const namespace = normalizeTableGroupNamespace(group);
    for (const tableName of Object.keys(group.schema.tables)) {
      const key = collectionKey(group.schema, namespace, tableName);
      if (registeredTableKeys.has(key)) {
        throw new Error(`Duplicate streamed table registration: ${key}.`);
      }
      registeredTableKeys.add(key);
    }
  }
};

const createTableViewCollection = (options: {
  id: string;
  sourceCollection: Collection<StreamSourceRow, string>;
  table: AnyTable;
  tableKey: string;
}): Collection<Record<string, unknown>, string> => {
  const { id, sourceCollection, table, tableKey } = options;
  const idColumnName = table.getIdColumn().name;
  const collection = createLiveQueryCollection({
    id,
    query: (query) =>
      query
        .from({ source: sourceCollection })
        .where(({ source }) => eq(source.tableKey, tableKey))
        .select(({ source }) => ({ ...source.row })),
    getKey: (row) => {
      const idValue = row[idColumnName];
      if (typeof idValue !== "string") {
        throw new Error(`Streamed row key ${table.name}.${idColumnName} must be a string.`);
      }
      return idValue;
    },
    startSync: false,
    gcTime: 0,
  });

  return collection as unknown as Collection<Record<string, unknown>, string>;
};

export function createCollectionRegistry(options: {
  url: string;
  tableGroups: readonly FragnoStreamTableGroup[];
  registrationIdentity?: string;
  persistence?: FragnoStreamDBPersistence;
  sourceActivation: SourceCollectionActivationBridge;
}): CollectionRegistry {
  const { url, tableGroups, persistence, sourceActivation } = options;
  const persistenceWrites = persistence
    ? new PersistenceWriteTracker(checkpointGenerationFromPersistedTx)
    : undefined;
  const persistenceProvider =
    persistence && persistenceWrites
      ? trackPersistenceWrites({ persistence: persistence.provider, tracker: persistenceWrites })
      : undefined;
  assertUniqueTableGroups(tableGroups);
  const tables = new Map<string, RegisteredTable>();

  const collectionIdentity = persistence ? `${persistence.scope}:${url}` : url;
  const sourceCollectionId = `fragno-stream-db:v4:${collectionIdentity}:${
    options.registrationIdentity ?? createTableGroupIdentity(tableGroups)
  }`;
  let sourceHandler: SourceSyncHandler | undefined;
  let resolveSourceHandlerReady!: () => void;
  const sourceHandlerReady = new Promise<void>((resolve) => {
    resolveSourceHandlerReady = resolve;
  });
  const sourceSync: SyncConfig<StreamSourceRow, string> = {
    rowUpdateMode: "full",
    sync: ({ begin, write, commit, truncate, markReady, metadata }) => {
      const handler: SourceSyncHandler = {
        begin,
        write: write as SyncWrite,
        commit,
        truncate,
        markReady,
        metadata,
      };
      sourceHandler = handler;
      resolveSourceHandlerReady();
      try {
        sourceActivation.activate(handler);
      } catch (error) {
        if (sourceHandler === handler) {
          sourceHandler = undefined;
        }
        throw error;
      }
      return () => {
        if (sourceHandler === handler) {
          sourceHandler = undefined;
        }
      };
    },
  };
  const sourceOptions = {
    id: sourceCollectionId,
    getKey: (row: StreamSourceRow) => row.id,
    sync: sourceSync,
    startSync: false,
    gcTime: 0,
  };
  let resolvedPersistence: PersistedCollectionPersistence | undefined;
  let sourceCollection: Collection<StreamSourceRow, string>;
  if (persistence) {
    const persistedOptions = persistedCollectionOptions<StreamSourceRow, string>({
      ...sourceOptions,
      persistence: persistenceProvider!,
      schemaVersion: persistence.version,
    });
    resolvedPersistence = persistedOptions.persistence;
    sourceCollection = createCollection<StreamSourceRow, string>(persistedOptions) as Collection<
      StreamSourceRow,
      string
    >;
  } else {
    sourceCollection = createCollection<StreamSourceRow, string>(sourceOptions);
  }

  for (const group of tableGroups) {
    const namespace = normalizeTableGroupNamespace(group);

    for (const [tableName, table] of Object.entries(group.schema.tables)) {
      const key = collectionKey(group.schema, namespace, tableName);
      const collection = createTableViewCollection({
        id: `${sourceCollectionId}:view:${key}`,
        sourceCollection,
        table,
        tableKey: key,
      });
      const registered: RegisteredTable = {
        table,
        key,
        collection,
        preloadCollection: collection.preload.bind(collection),
      };
      tables.set(key, registered);
    }
  }

  return {
    tables,
    sourceCollectionId,
    sourceCollection,
    sourceHandlerReady,
    getSourceHandler: () => sourceHandler,
    materializedRows: new Map(),
    persistence: resolvedPersistence,
    persistenceWrites,
    coordinator: resolvedPersistence?.coordinator,
  };
}

export const parseStreamCheckpoint = (
  value: unknown,
  path: string,
  parseOffset: (value: unknown, path: string) => string,
): StreamCheckpoint => {
  if (
    !isRecord(value) ||
    typeof value["cacheVersion"] !== "number" ||
    !Number.isInteger(value["cacheVersion"]) ||
    value["cacheVersion"] < 0 ||
    typeof value["ownerId"] !== "string" ||
    typeof value["generation"] !== "string" ||
    typeof value["upToDate"] !== "boolean"
  ) {
    throw new Error(`${path} is not a valid Fragno stream checkpoint.`);
  }

  return {
    offset: parseOffset(value["offset"], `${path}.offset`),
    cacheVersion: value["cacheVersion"],
    ownerId: value["ownerId"],
    generation: value["generation"],
    upToDate: value["upToDate"],
  };
};

export const checkpointFrom = (row: StreamSourceRow | undefined): StreamCheckpoint | undefined => {
  if (row?.id !== CHECKPOINT_SOURCE_ID || row.tableKey !== CHECKPOINT_TABLE_KEY) {
    return undefined;
  }
  return row.checkpoint ?? undefined;
};

const checkpointGenerationFromPersistedTx = (tx: PersistedTx): string | undefined => {
  for (const mutation of tx.mutations) {
    if (mutation.type === "delete") {
      continue;
    }
    const checkpoint = checkpointFrom(mutation.value as StreamSourceRow);
    if (checkpoint) {
      return checkpoint.generation;
    }
  }
  return undefined;
};

const parsePersistedSourceRow = (
  value: unknown,
  parseOffset: (value: unknown, path: string) => string,
): StreamSourceRow => {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["tableKey"] !== "string" ||
    typeof value["externalId"] !== "string" ||
    !isRecord(value["row"])
  ) {
    throw new Error("Persisted Fragno stream source row has an invalid shape.");
  }

  const isCheckpointRow =
    value["id"] === CHECKPOINT_SOURCE_ID && value["tableKey"] === CHECKPOINT_TABLE_KEY;
  if (!isCheckpointRow && value["checkpoint"] !== null) {
    throw new Error("Persisted Fragno materialized row contains checkpoint data.");
  }

  return {
    id: value["id"],
    tableKey: value["tableKey"],
    externalId: value["externalId"],
    row: value["row"],
    checkpoint: isCheckpointRow
      ? parseStreamCheckpoint(value["checkpoint"], "persisted stream checkpoint", parseOffset)
      : null,
  };
};

export type PersistedMaterializedSourceRestore =
  | { status: "restored"; checkpoint: StreamCheckpoint | undefined }
  | { status: "corrupt" };

export async function restorePersistedMaterializedRows(options: {
  registry: CollectionRegistry;
  parseOffset: (value: unknown, path: string) => string;
}): Promise<PersistedMaterializedSourceRestore> {
  const { registry, parseOffset } = options;
  registry.materializedRows.clear();
  if (!registry.persistence) {
    return { status: "restored", checkpoint: undefined };
  }

  const persistedRows = await registry.persistence.adapter.loadSubset(
    registry.sourceCollectionId,
    {},
  );
  let checkpoint: StreamCheckpoint | undefined;
  try {
    for (const persistedRow of persistedRows) {
      const row = parsePersistedSourceRow(persistedRow.value, parseOffset);
      registry.materializedRows.set(row.id, row);
      checkpoint ??= checkpointFrom(row);
    }
  } catch {
    registry.materializedRows.clear();
    return { status: "corrupt" };
  }
  return { status: "restored", checkpoint };
}

export async function discardPersistedMaterializedSource(
  registry: CollectionRegistry,
  handler: SourceSyncHandler,
): Promise<void> {
  handler.begin();
  handler.truncate();
  handler.commit();
  registry.materializedRows.clear();
  await registry.persistenceWrites?.waitForIdle();
}

export function adaptStateMaterializationPlan(
  registry: CollectionRegistry,
  statePlan: StateMaterializationPlan,
): MaterializationPlan {
  const plan: MaterializationPlan = {
    writes: [],
    tableChanges: new Map(),
    reset: statePlan.reset,
    txids: statePlan.txids,
  };
  const existingKeys = new Set(
    statePlan.reset
      ? []
      : [...registry.materializedRows.values()]
          .filter((row) => row.checkpoint === null)
          .map((row) => row.id),
  );

  for (const change of statePlan.changes) {
    const table = registry.tables.get(change.collection.tableKey);
    if (!table) {
      throw new Error(`State collection ${change.collection.name} is not registered.`);
    }
    const id = sourceRowId(table.key, change.key);
    if (change.type === "delete") {
      if (existingKeys.delete(id)) {
        plan.writes.push({ type: "delete", key: id });
      }
      continue;
    }

    const sourceRow: StreamSourceRow = {
      id,
      tableKey: table.key,
      externalId: change.key,
      row: change.value,
      checkpoint: null,
    };
    plan.writes.push({ type: existingKeys.has(id) ? "update" : "insert", value: sourceRow });
    existingKeys.add(id);
  }

  return plan;
}

export function commitMaterializationPlan(options: {
  registry: CollectionRegistry;
  plan: MaterializationPlan;
  offset: string;
  cacheVersion: number;
  ownerId: string;
  generation: string;
  upToDate: boolean;
}): Promise<void> {
  const { registry, plan, offset, cacheVersion, ownerId, generation, upToDate } = options;
  const handler = registry.getSourceHandler();
  if (!handler) {
    throw new Error("TanStack DB source sync handler is not ready.");
  }

  const checkpoint: StreamSourceRow = {
    id: CHECKPOINT_SOURCE_ID,
    tableKey: CHECKPOINT_TABLE_KEY,
    externalId: CHECKPOINT_SOURCE_ID,
    row: {},
    checkpoint: { offset, cacheVersion, ownerId, generation, upToDate },
  };
  const checkpointExists = !plan.reset && registry.materializedRows.has(CHECKPOINT_SOURCE_ID);
  const checkpointCommit = registry.persistenceWrites?.waitForCheckpointCommit(generation);

  try {
    handler.begin();
    if (plan.reset) {
      handler.truncate();
    }
    for (const write of plan.writes) {
      handler.write(write);
    }
    handler.write({ type: checkpointExists ? "update" : "insert", value: checkpoint });
    handler.commit();
  } catch (error) {
    const transactionError = toError(error);
    registry.persistenceWrites?.rejectCheckpointCommit(generation, transactionError);
    throw transactionError;
  }

  if (plan.reset) {
    registry.materializedRows.clear();
  }
  for (const write of plan.writes) {
    if ("key" in write) {
      registry.materializedRows.delete(write.key);
    } else {
      registry.materializedRows.set(write.value.id, write.value);
    }
  }
  registry.materializedRows.set(checkpoint.id, checkpoint);

  return checkpointCommit ?? Promise.resolve();
}

type CheckpointObservationWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

export class CheckpointObservationTracker {
  readonly #waiters = new Map<string, Set<CheckpointObservationWaiter>>();
  readonly #currentCheckpoint: () => StreamCheckpoint | undefined;

  constructor(currentCheckpoint: () => StreamCheckpoint | undefined) {
    this.#currentCheckpoint = currentCheckpoint;
  }

  observe(generation: string): void {
    for (const waiter of this.#waiters.get(generation) ?? []) {
      waiter.resolve();
    }
    this.#waiters.delete(generation);
  }

  waitFor(generation: string): Promise<void> {
    if (this.#currentCheckpoint()?.generation === generation) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiters = this.#waiters.get(generation) ?? new Set();
      waiters.add({ resolve, reject });
      this.#waiters.set(generation, waiters);
    });
  }

  close(error: Error): void {
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    }
    this.#waiters.clear();
  }
}

export function applyObservedSourceChanges(
  registry: CollectionRegistry,
  checkpointObservations: CheckpointObservationTracker,
  changes: SourceCollectionChanges,
): void {
  for (const change of changes) {
    if (change.type === "delete") {
      registry.materializedRows.delete(String(change.key));
      continue;
    }

    const row = change.value as StreamSourceRow;
    registry.materializedRows.set(row.id, row);
    const checkpoint = checkpointFrom(row);
    if (checkpoint) {
      checkpointObservations.observe(checkpoint.generation);
    }
  }
}
