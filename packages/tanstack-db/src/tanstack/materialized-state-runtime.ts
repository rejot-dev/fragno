import type { AnySchema, AnyTable } from "@fragno-dev/db/schema";

import type { JsonBatch } from "@durable-streams/client";
import type { StateEvent } from "@durable-streams/state";
import type { Collection } from "@tanstack/db";
import type { PersistedCollectionCoordinator } from "@tanstack/db-sqlite-persistence-core";

import { parseStreamOffset } from "../consumer/stream-offset";
import {
  createStateRegistry,
  planStateBatch,
  type StateRegistry,
} from "../materialization/plan-state-batch";
import {
  createFragnoStateFingerprint,
  type AnyFragnoStateSchema,
  type FragnoStreamRow,
} from "../state/fragno-state-schema";
import { TanStackReadinessBridge } from "./readiness";
import {
  adaptStateMaterializationPlan,
  applyObservedSourceChanges,
  CHECKPOINT_SOURCE_ID,
  checkpointFrom,
  CheckpointObservationTracker,
  collectionKey,
  commitMaterializationPlan,
  createCollectionRegistry,
  createSourceCollectionActivationBridge,
  discardPersistedMaterializedSource,
  restorePersistedMaterializedRows,
  sourceRowId,
  type CollectionRegistry,
  type FragnoStreamDBPersistence,
  type FragnoStreamTableGroup,
  type StreamCheckpoint,
  type StreamSourceRow,
} from "./state-sink";

type MaterializedStateRuntimeOptions<TState extends AnyFragnoStateSchema> = {
  state: TState;
  streamUrl: string;
  persistence?: FragnoStreamDBPersistence;
  waitForStreamReady(): Promise<void>;
  onActivation(): void;
  onPrepared(checkpoint: StreamCheckpoint | undefined): void;
  onEvent?: (event: StateEvent) => void;
};

type StateCollectionRow<TDefinition> = TDefinition extends {
  fragno: { table: infer TTable };
}
  ? TTable extends AnyTable
    ? FragnoStreamRow<TTable>
    : never
  : never;

export type FragnoStreamDBCollections<TState extends AnyFragnoStateSchema> = {
  [TName in keyof TState]: Collection<StateCollectionRow<TState[TName]>, string>;
};

export type CommittedStateBatch = {
  checkpoint: StreamCheckpoint;
  txids: readonly string[];
};

const tableGroupsFromState = (state: AnyFragnoStateSchema): FragnoStreamTableGroup[] => {
  const tableGroups: FragnoStreamTableGroup[] = [];
  const seen = new Map<AnySchema, Set<string | null>>();

  for (const definition of Object.values(state)) {
    const namespaces = seen.get(definition.fragno.schema) ?? new Set<string | null>();
    if (namespaces.has(definition.fragno.namespace)) {
      continue;
    }
    namespaces.add(definition.fragno.namespace);
    seen.set(definition.fragno.schema, namespaces);
    tableGroups.push({
      schema: definition.fragno.schema,
      namespace: definition.fragno.namespace,
    });
  }

  return tableGroups;
};

/** Owns the authoritative TanStack source, persisted hydration, and atomic State Protocol commits. */
export class MaterializedStateRuntime<TState extends AnyFragnoStateSchema> {
  readonly collections: FragnoStreamDBCollections<TState>;
  readonly #options: MaterializedStateRuntimeOptions<TState>;
  readonly #stateRegistry: StateRegistry;
  readonly #registry: CollectionRegistry;
  readonly #readiness: TanStackReadinessBridge<StreamSourceRow>;
  readonly #checkpointObservations: CheckpointObservationTracker;
  readonly #tableSubscriberUnsubscribes: Array<() => void> = [];
  #preparePromise: Promise<void> | undefined;
  #sourceSubscription:
    | ReturnType<Collection<StreamSourceRow, string>["subscribeChanges"]>
    | undefined;
  #sourceObservationStarting = false;
  #checkpointGeneration = 0;

  constructor(options: MaterializedStateRuntimeOptions<TState>) {
    this.#options = options;
    const sourceActivation = createSourceCollectionActivationBridge();
    this.#registry = createCollectionRegistry({
      url: options.streamUrl,
      tableGroups: tableGroupsFromState(options.state),
      registrationIdentity: createFragnoStateFingerprint(options.state),
      persistence: options.persistence,
      sourceActivation,
    });
    this.#stateRegistry = createStateRegistry(options.state, {
      tableKeyFor: (definition) =>
        collectionKey(
          definition.fragno.schema,
          definition.fragno.namespace,
          definition.fragno.table.name,
        ),
    });
    // The registry was derived from this exact TState and verifies every named table view below.
    // Object.fromEntries cannot preserve that key-to-row-type correlation, so assert it here only.
    this.collections = Object.fromEntries(
      [...this.#stateRegistry.collections.values()].map((collection) => {
        const table = this.#registry.tables.get(collection.tableKey);
        if (!table) {
          throw new Error(`State collection ${collection.name} has no TanStack table view.`);
        }
        return [collection.name, table.collection];
      }),
    ) as unknown as FragnoStreamDBCollections<TState>;
    this.#readiness = new TanStackReadinessBridge({
      sourceCollection: this.#registry.sourceCollection,
      publicCollections: [...this.#registry.tables.values()],
      getSourceHandler: this.#registry.getSourceHandler,
      waitForStreamReady: options.waitForStreamReady,
    });
    this.#checkpointObservations = new CheckpointObservationTracker(() =>
      checkpointFrom(this.#registry.sourceCollection.get(CHECKPOINT_SOURCE_ID)),
    );

    sourceActivation.attach(() => options.onActivation());
    this.#readiness.installPublicCollectionReadiness();
    this.#installTableConsumerActivation();
  }

  get coordinator(): PersistedCollectionCoordinator | undefined {
    return this.#registry.coordinator;
  }

  get sourceCollectionId(): string {
    return this.#registry.sourceCollectionId;
  }

  get persistenceVersion(): number {
    return this.#options.persistence?.version ?? 0;
  }

  prepare(): Promise<void> {
    if (!this.#preparePromise) {
      const prepare = this.#prepare();
      void prepare.catch(() => undefined);
      this.#preparePromise = prepare;
    }
    return this.#preparePromise;
  }

  ensureSourceObservation(): void {
    if (this.#sourceSubscription || this.#sourceObservationStarting) {
      return;
    }

    this.#sourceObservationStarting = true;
    try {
      this.#sourceSubscription = this.#registry.sourceCollection.subscribeChanges((changes) =>
        applyObservedSourceChanges(this.#registry, this.#checkpointObservations, changes),
      );
    } finally {
      this.#sourceObservationStarting = false;
    }
  }

  async commitBatch(
    batch: JsonBatch<unknown>,
    ownerId: string,
    offset: string,
  ): Promise<CommittedStateBatch> {
    const plan = adaptStateMaterializationPlan(
      this.#registry,
      planStateBatch({
        registry: this.#stateRegistry,
        items: batch.items,
        readRow: (collection, key) =>
          this.#registry.materializedRows.get(sourceRowId(collection.tableKey, key))?.row,
        onEvent: this.#options.onEvent,
      }),
    );
    const generation = `${ownerId}:${++this.#checkpointGeneration}`;
    const checkpoint: StreamCheckpoint = {
      offset,
      cacheVersion: this.persistenceVersion,
      ownerId,
      generation,
      upToDate: batch.upToDate,
    };

    await commitMaterializationPlan({
      registry: this.#registry,
      plan,
      ...checkpoint,
    });

    return { checkpoint, txids: plan.txids ?? [] };
  }

  currentCheckpoint(): StreamCheckpoint | undefined {
    return checkpointFrom(this.#registry.sourceCollection.get(CHECKPOINT_SOURCE_ID));
  }

  waitForCheckpointGeneration(generation: string): Promise<void> {
    return this.#checkpointObservations.waitFor(generation);
  }

  markReady(): Promise<void> {
    return this.#readiness.markReady();
  }

  markTerminalError(): void {
    this.#readiness.markTerminalError();
  }

  waitForPersistenceIdle(): Promise<void> {
    return this.#registry.persistenceWrites?.waitForIdle() ?? Promise.resolve();
  }

  beginClose(error: Error): void {
    for (const unsubscribe of this.#tableSubscriberUnsubscribes.splice(0)) {
      unsubscribe();
    }
    this.#sourceSubscription?.unsubscribe();
    this.#registry.persistenceWrites?.rejectPendingCheckpointCommits(error);
    this.#checkpointObservations.close(error);
  }

  async finishClose(): Promise<void> {
    await this.waitForPersistenceIdle();
    await Promise.all(
      [...this.#registry.tables.values()].map(({ collection }) => collection.cleanup()),
    );
    await this.#registry.sourceCollection.cleanup();
  }

  async #prepare(): Promise<void> {
    const sourcePreload = this.#registry.sourceCollection.preload();
    void sourcePreload.catch(() => undefined);
    this.#readiness.startTableCollections();
    await this.#registry.sourceHandlerReady;
    const handler = this.#registry.getSourceHandler();
    if (!handler) {
      throw new Error("TanStack DB source sync handler disappeared during startup.");
    }

    const persistedSource = await restorePersistedMaterializedRows({
      registry: this.#registry,
      parseOffset: parseStreamOffset,
    });
    if (persistedSource.status === "corrupt") {
      await discardPersistedMaterializedSource(this.#registry, handler);
      this.#options.onPrepared(undefined);
      return;
    }

    const { checkpoint } = persistedSource;
    if (
      this.#options.persistence &&
      checkpoint &&
      checkpoint.cacheVersion !== this.#options.persistence.version
    ) {
      await discardPersistedMaterializedSource(this.#registry, handler);
      this.#options.onPrepared(undefined);
      return;
    }

    this.#options.onPrepared(checkpoint);
  }

  #installTableConsumerActivation(): void {
    for (const { collection } of this.#registry.tables.values()) {
      this.#tableSubscriberUnsubscribes.push(
        collection.on("subscribers:change", ({ previousSubscriberCount, subscriberCount }) => {
          if (previousSubscriberCount === 0 && subscriberCount > 0) {
            this.#options.onActivation();
          }
        }),
      );
    }
  }
}
