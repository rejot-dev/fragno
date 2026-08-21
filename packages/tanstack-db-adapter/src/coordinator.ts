import { FRAGNO_OUTBOX_PAGE_SIZE } from "@fragno-dev/db/outbox";
import type { TableToColumnValues } from "@fragno-dev/db/query";
import type { AnySchema, AnyTable, FragnoId, FragnoReference } from "@fragno-dev/db/schema";

import type { Collection } from "@tanstack/db";
import type { PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";

import { FragnoCollectionRegistry } from "./coordinator/fragno-collection-registry";
import {
  FRAGNO_INTERNAL_COLLECTION_ID,
  FRAGNO_INTERNAL_FLUSH_MARKER_METADATA_KEY,
  FragnoInternalCollection,
  type FragnoOutboxCoordinatorState,
} from "./coordinator/fragno-internal-collection";
import { FragnoInternalFetcher } from "./coordinator/fragno-internal-fetcher";
import { orderFragnoPersistenceWrites } from "./coordinator/fragno-ordered-persistence";
import { FragnoOutboxSynchronizer } from "./coordinator/fragno-outbox-synchronizer";

/**
 * Problem statement
 * -----------------
 * One Fragno database produces one globally ordered outbox containing mutations for every schema
 * and table stored in that database. The browser should mirror that outbox into one local database,
 * not create an independent transport, checkpoint, or persistence database for every collection.
 *
 * `createFragnoOutboxCoordinator` therefore receives only:
 *
 * - the mounted Fragment base URL;
 * - the Fetch implementation used to call it;
 * - every Fragno schema represented by that outbox.
 *
 * From those inputs it owns the complete local database: source identity, persistence, one exact
 * outbox checkpoint, one catch-up loop, one live stream, and every table collection registered
 * before preload. Callers register typed collections but cannot configure synchronization
 * independently.
 *
 * Data flow
 * ---------
 *
 * createFragnoOutboxCoordinator({ baseUrl, fetch, schemas })
 *   -> derive the Fragno internal outbox URL from baseUrl
 *   -> resolve the physical database adapter identity
 *   -> open one local persistence database for that base URL + adapter identity
 *   -> coordinator.collection(schema, table) lazily registers each requested table collection
 *   -> coordinator.preload() closes registration and preloads every registered collection
 *   -> each collection's sync callback subscribes to the shared outbox synchronizer
 *   -> read the database's one exact persisted outbox checkpoint
 *   -> GET ordered 500-entry outbox pages from the aligned checkpoint boundary
 *   -> validate and decode each outbox entry once
 *   -> route every operation to its schema/table collection
 *   -> commit all affected collections before advancing the database checkpoint
 *   -> mark every collection ready together
 *   -> later open the live stream from the exact catch-up checkpoint
 *   -> TanStack live queries update the UI
 *
 * Invariants
 * ----------
 *
 * - one outbox maps to exactly one local database;
 * - every requested table collection is registered before catch-up starts;
 * - one exact checkpoint describes the complete local database, not an individual collection;
 * - an entry advances that checkpoint only after every affected collection has committed;
 * - entries without relevant operations still advance the checkpoint;
 * - replay from an aligned page never reapplies entries at or before the exact checkpoint;
 * - changing adapter identity discards the previous local database materialization;
 * - persisted rows alone never make collections ready before network catch-up finishes;
 * - cleanup stops the shared request, stream, persistence, and every generated collection.
 */

type MaterializedColumnValue<TValue> = TValue extends FragnoId | FragnoReference ? string : TValue;

type VisibleTableValues<TTable extends AnyTable> = TableToColumnValues<TTable>;

export type FragnoCollectionRow<TTable extends AnyTable> = {
  [TColumnName in keyof VisibleTableValues<TTable> as [
    VisibleTableValues<TTable>[TColumnName],
  ] extends [null]
    ? never
    : TColumnName]: MaterializedColumnValue<VisibleTableValues<TTable>[TColumnName]>;
};

export type { FragnoOutboxCheckpoint } from "./checkpoint";

export {
  FragnoInternalCollection,
  type FragnoInternalRow,
  type FragnoOutboxCoordinatorError,
  type FragnoOutboxCoordinatorState,
} from "./coordinator/fragno-internal-collection";

export const FRAGNO_OUTBOX_LOCAL_SCHEMA_VERSION = 1;

const FRAGNO_OUTBOX_STARTUP_TIMEOUT_MS = 5_000;

export type { FragnoInternalDescription } from "./coordinator/fragno-internal-fetcher";

export async function fetchFragnoOutboxDescription(options: {
  baseUrl: string | URL;
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
}) {
  return await new FragnoInternalFetcher(options).describe({ signal: options.signal });
}

export type FragnoOutboxCatchUpProgress = {
  completedPages: number;
  totalPages: number;
  percent: number;
};

export type FragnoOutboxCoordinatorDependencies = {
  openPersistence(options: { databaseName: string }): Promise<{
    persistence: PersistedCollectionPersistence;
    cleanup(): Promise<void>;
  }>;
};

export type FragnoCollectionOptions = {
  /** Use `full` only for tables that never receive updates; Fragno update entries contain patches. */
  rowUpdateMode?: "partial" | "full";
  skipMissingTruncateDeletes?: boolean;
};

export type FragnoOutboxCoordinator<TSchemas extends readonly AnySchema[]> = {
  /** Persisted coordinator metadata and user-queryable lifecycle status. */
  readonly internal: FragnoInternalCollection;

  /** Current synchronization lifecycle state. */
  readonly state: FragnoOutboxCoordinatorState;

  collection<TSchema extends TSchemas[number], TTableName extends keyof TSchema["tables"] & string>(
    schema: TSchema,
    table: TTableName,
    options?: FragnoCollectionOptions,
  ): Collection<FragnoCollectionRow<TSchema["tables"][TTableName]>, string>;

  /** Preloads every generated collection and resolves after shared initial catch-up. */
  preload(): Promise<void>;

  /** Waits until every accepted local persistence write is durable. */
  flushPersistence(): Promise<void>;

  /** Stops synchronization and closes every collection and local database resource. */
  cleanup(): Promise<void>;
};

export async function createFragnoOutboxCoordinator<const TSchemas extends readonly AnySchema[]>(
  options: {
    baseUrl: string | URL;
    fetch: typeof globalThis.fetch;
    schemas: TSchemas;
    onCatchUpProgress?(progress: FragnoOutboxCatchUpProgress): void;
  },
  dependencies: FragnoOutboxCoordinatorDependencies = {
    openPersistence: openBrowserFragnoOutboxPersistence,
  },
): Promise<FragnoOutboxCoordinator<TSchemas>> {
  // State transitions:
  // opening -> idle -> registering -> catching-up -> caught-up -> live
  // opening | registering | catching-up | caught-up | live -> failed
  // idle | registering | catching-up | caught-up | live | failed -> disposed
  let state: FragnoOutboxCoordinatorState = "opening";

  const internalFetcher = new FragnoInternalFetcher({
    baseUrl: options.baseUrl,
    fetch: options.fetch,
  });

  // Fetch the backend adapter identity before opening local persistence.
  const { adapterIdentity, currentVersionstamp } = await internalFetcher.describe();

  // Derive one stable, filename-safe local database name from baseUrl and adapter identity.
  const databaseHash = await sha256Hex(
    `${internalFetcher.baseUrl}\0${adapterIdentity}\0version:${FRAGNO_OUTBOX_LOCAL_SCHEMA_VERSION}`,
  );
  // OPFSCoopSyncVFS fails to open filenames above 56 characters in some Electron/Chromium
  // runtimes. A 128-bit hash keeps this deterministic and collision-resistant within that limit.
  // The v3 prefix leaves behind databases created with the temporary single-process wiring.
  const databaseName = `fragno-v3-${databaseHash.slice(0, 32)}.sqlite`;

  const persistenceResource = await waitForFragnoOutboxStartupStage(
    dependencies.openPersistence({ databaseName }),
    "opening browser persistence",
  );
  const persistence = orderFragnoPersistenceWrites(persistenceResource.persistence);

  let internalCollection: FragnoInternalCollection | undefined;
  let outboxSynchronizer: FragnoOutboxSynchronizer | undefined;
  let collectionRegistry: FragnoCollectionRegistry<TSchemas> | undefined;

  try {
    // Load the one exact outbox checkpoint stored for this database.
    internalCollection = new FragnoInternalCollection({
      persistence,
      schemaVersion: FRAGNO_OUTBOX_LOCAL_SCHEMA_VERSION,
      state,
    });
    await waitForFragnoOutboxStartupStage(
      internalCollection.preload(),
      "preloading coordinator metadata",
    );

    let completedCatchUpPages = 0;
    const initialCheckpoint = internalCollection.getCheckpoint();
    const totalCatchUpPages = catchUpPageCount(
      initialCheckpoint?.versionstamp,
      currentVersionstamp,
    );
    outboxSynchronizer = new FragnoOutboxSynchronizer({
      fetcher: internalFetcher,
      checkpointStore: internalCollection,
      onCatchUpPage() {
        completedCatchUpPages += 1;
        options.onCatchUpProgress?.({
          completedPages: completedCatchUpPages,
          totalPages: totalCatchUpPages,
          percent:
            totalCatchUpPages === 0
              ? 100
              : Math.min(100, Math.round((completedCatchUpPages / totalCatchUpPages) * 100)),
        });
      },
    });
    collectionRegistry = new FragnoCollectionRegistry({
      schemas: options.schemas,
      persistence,
      schemaVersion: FRAGNO_OUTBOX_LOCAL_SCHEMA_VERSION,
      outbox: outboxSynchronizer,
    });
  } catch (error) {
    outboxSynchronizer?.dispose();
    await internalCollection?.cleanup().catch(() => {});
    await persistenceResource.cleanup().catch(() => {});
    throw error;
  }

  if (!internalCollection || !outboxSynchronizer || !collectionRegistry) {
    await persistenceResource.cleanup();
    throw new Error("Fragno outbox coordinator initialization did not complete.");
  }

  const initializedInternalCollection = internalCollection;
  const initializedOutboxSynchronizer = outboxSynchronizer;
  const initializedCollectionRegistry = collectionRegistry;

  // The adapter identity is part of the local database name, so a changed backend opens a new
  // database instead of reusing the previous source's persisted collections.

  // Registered targets are not versioned in local metadata. When adding or removing a collection,
  // delete this coordinator's local persistence database so every registered table catches up from
  // the beginning against one fresh shared checkpoint.

  // TanStack exposes no atomic cross-collection UI transaction. Every affected collection commits
  // an applied-entry checkpoint atomically with its own row changes, making partial entry replay
  // idempotent before the shared database checkpoint advances.

  let preloadPromise: Promise<void> | undefined;
  let streamPromise: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const transitionTo = (nextState: FragnoOutboxCoordinatorState, error: unknown = null) => {
    state = nextState;
    initializedInternalCollection.setState(nextState, error);
  };

  const transitionToFailed = (error: unknown) => {
    if (state !== "disposed") {
      transitionTo("failed", error);
    }
  };

  transitionTo("idle");

  const flushPersistence = () => {
    const marker = globalThis.crypto.randomUUID();
    const persisted = persistence.waitForCollectionMetadata(
      FRAGNO_INTERNAL_COLLECTION_ID,
      FRAGNO_INTERNAL_FLUSH_MARKER_METADATA_KEY,
      marker,
    );
    initializedInternalCollection.setFlushMarker(marker);
    return persisted;
  };

  const isDisposed = () => state === "disposed";

  const startStreaming = () => {
    streamPromise ??= (async () => {
      let retryAttempt = 0;

      while (!isDisposed()) {
        try {
          await initializedOutboxSynchronizer.stream({
            onOpen() {
              retryAttempt = 0;
              if (state === "caught-up" || state === "replaying") {
                transitionTo("live");
              }
            },
          });
        } catch (error) {
          if (isDisposed() || isAbortError(error)) {
            return;
          }

          transitionTo("retrying", error);
          retryAttempt += 1;
          await waitForRetry(retryAttempt);
          if (isDisposed()) {
            return;
          }

          try {
            transitionTo("replaying");
            await initializedOutboxSynchronizer.replay();
          } catch (replayError) {
            if (isDisposed() || isAbortError(replayError)) {
              return;
            }
            transitionTo("retrying", replayError);
            continue;
          }
        }
      }
    })();
    void streamPromise.catch(transitionToFailed);
  };

  return {
    internal: initializedInternalCollection,

    get state() {
      return state;
    },

    collection(schema, tableName, collectionOptions) {
      return initializedCollectionRegistry.registerCollection(
        schema,
        tableName,
        state,
        collectionOptions,
      );
    },

    preload() {
      preloadPromise ??= (async () => {
        if (state !== "idle") {
          throw new Error(`Cannot preload Fragno collections while the coordinator is ${state}.`);
        }

        try {
          transitionTo("registering");
          const collectionsReady = initializedCollectionRegistry.preload();
          const collectionsRegistered = initializedOutboxSynchronizer.waitUntilRegistered(
            initializedCollectionRegistry.registeredTargets(),
          );
          await waitForFragnoOutboxStartupStage(
            Promise.race([
              collectionsRegistered,
              collectionsReady.then(() => {
                throw new Error(
                  "Fragno collections became ready before outbox synchronization registration completed.",
                );
              }),
            ]),
            "registering synchronized collections",
          );

          transitionTo("catching-up");
          await initializedOutboxSynchronizer.catchUp();
          await collectionsReady;
          transitionTo("caught-up");
          startStreaming();
        } catch (error) {
          transitionToFailed(error);
          throw error;
        }
      })();

      return preloadPromise;
    },

    flushPersistence,

    cleanup() {
      cleanupPromise ??= (async () => {
        transitionTo("disposed");
        initializedOutboxSynchronizer.dispose();
        await preloadPromise?.catch(() => {});
        await streamPromise?.catch(() => {});

        const errors: unknown[] = [];
        for (const cleanup of [
          flushPersistence,
          () => initializedCollectionRegistry.cleanup(),
          () => initializedInternalCollection.cleanup(),
          () => persistence.drain(),
          () => persistenceResource.cleanup(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            errors.push(error);
          }
        }

        if (errors.length > 0) {
          throw new AggregateError(errors, "Failed to clean up the Fragno outbox coordinator.");
        }
      })();

      return cleanupPromise;
    },
  };
}

async function waitForFragnoOutboxStartupStage<T>(
  stagePromise: Promise<T>,
  stage: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(
          `Fragno outbox startup timed out after ${FRAGNO_OUTBOX_STARTUP_TIMEOUT_MS}ms while ${stage}.`,
        ),
      );
    }, FRAGNO_OUTBOX_STARTUP_TIMEOUT_MS);
  });

  try {
    return await Promise.race([stagePromise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function waitForRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(1_000, 25 * 2 ** Math.min(attempt - 1, 5));
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function catchUpPageCount(
  checkpointVersionstamp: string | undefined,
  currentVersionstamp: string | null,
): number {
  if (!currentVersionstamp) {
    return 1;
  }

  const checkpointVersion = checkpointVersionstamp
    ? BigInt(`0x${checkpointVersionstamp.slice(0, 20)}`)
    : 0n;
  const currentVersion = BigInt(`0x${currentVersionstamp.slice(0, 20)}`);
  const remainingEntries =
    currentVersion > checkpointVersion ? currentVersion - checkpointVersion : 0n;
  return Math.max(
    1,
    Number(
      (remainingEntries + BigInt(FRAGNO_OUTBOX_PAGE_SIZE) - 1n) / BigInt(FRAGNO_OUTBOX_PAGE_SIZE),
    ),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function openBrowserFragnoOutboxPersistence(options: { databaseName: string }): Promise<{
  persistence: PersistedCollectionPersistence;
  cleanup(): Promise<void>;
}> {
  const {
    BrowserCollectionCoordinator,
    createBrowserWASQLitePersistence,
    openBrowserWASQLiteOPFSDatabase,
  } = await import("@tanstack/browser-db-sqlite-persistence");
  const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: options.databaseName });
  const coordinator = new BrowserCollectionCoordinator({ dbName: options.databaseName });

  return {
    persistence: createBrowserWASQLitePersistence({ database, coordinator }),
    async cleanup() {
      coordinator.dispose();
      await database.close?.();
    },
  };
}
