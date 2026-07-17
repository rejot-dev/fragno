import type { AnySchema } from "@fragno-dev/db/schema";
import { atom, type ReadableAtom } from "nanostores";

import { LofiClient } from "../client";
import type {
  LofiAdapter,
  LofiClientOptions,
  LofiEphemeralTable,
  LofiMutation,
  LofiMutationOp,
  LofiQueryableAdapter,
  LofiResolvedTypedMutation,
  LofiSyncResult,
} from "../types";
import { createLofiRuntimeStore, type LofiRuntimeStoreFactory } from "./query-store";
import { createLofiRuntimeTx, type LofiRuntimeTxFactory } from "./tx";

export type LofiRuntimeSource = {
  id: string;
  outboxUrl: string;
  outboxStreamUrl?: string;
  outboxTransport?: LofiClientOptions["outboxTransport"];
  cursorKey?: string;
  pollIntervalMs?: number;
  streamReconnectIntervalMs?: number;
  limit?: number;
};

export type LofiRuntimeStatusValue =
  | "idle"
  | "bootstrapping"
  | "bootstrapped"
  | "running"
  | "syncing";

export type LofiRuntimeSourceStatusValue = Exclude<LofiRuntimeStatusValue, "running">;

export type LofiRuntimeSourceStatus = {
  status: LofiRuntimeSourceStatusValue;
  lastSyncAt?: number;
  lastVersionstamp?: string;
  lastError?: unknown;
};

export type LofiRuntimeStatus = {
  status: LofiRuntimeStatusValue;
  lastSyncAt?: number;
  lastVersionstamp?: string;
  lastAppliedSourceId?: string;
  lastError?: unknown;
  sources: Record<string, LofiRuntimeSourceStatus>;
};

export const isLofiRuntimeBootstrapped = (status: LofiRuntimeStatus): boolean =>
  Object.values(status.sources).every((source) => source.status === "bootstrapped");

export type LofiRuntimeSyncResult = {
  appliedEntries: number;
  lastVersionstamp?: string;
  sources: Record<string, LofiSyncResult>;
};

export type LofiRuntimeOptions = {
  endpointName: string;
  adapter: LofiAdapter & LofiQueryableAdapter;
  ephemeralTables?: readonly LofiEphemeralTable[];
  sources?: LofiRuntimeSource[];
  outboxUrl?: string;
  fetch?: typeof fetch;
  outboxTransport?: LofiClientOptions["outboxTransport"];
  pollIntervalMs?: number;
  streamReconnectIntervalMs?: number;
  limit?: number;
  signal?: AbortSignal;
  autoStart?: boolean;
  keepAlive?: boolean;
  bootstrap?: boolean;
};

export type LofiRuntime = {
  endpointName: string;
  adapter: LofiAdapter & LofiQueryableAdapter;
  isEphemeralTable: (schema: string, table: string) => boolean;
  /** Subscribes after references are resolved and unresolved DbNow values are rejected. */
  subscribeEphemeral: <
    const TSchema extends AnySchema,
    const TTableName extends keyof TSchema["tables"] & string,
  >(
    schema: TSchema,
    table: TTableName,
    listener: (mutation: LofiResolvedTypedMutation<TSchema, TTableName, LofiMutationOp>) => void,
  ) => () => void;
  $status: ReadableAtom<LofiRuntimeStatus>;
  $revision: ReadableAtom<number>;
  start: () => void;
  stop: () => void;
  retain: () => () => void;
  bootstrap: (sourceId?: string) => Promise<LofiRuntimeSyncResult>;
  whenBootstrapped: () => Promise<void>;
  syncOnce: (sourceId?: string) => Promise<LofiRuntimeSyncResult>;
  refresh: () => void;
  tx: LofiRuntimeTxFactory;
  store: LofiRuntimeStoreFactory;
  addSource: (source: LofiRuntimeSource) => void;
  removeSource: (sourceId: string) => void;
};

type SourceRuntime = {
  source: LofiRuntimeSource;
  cursorKey: string;
  client: LofiClient;
};

const createInitialStatus = (status: LofiRuntimeStatusValue): LofiRuntimeStatus => ({
  status,
  sources: {},
});

const getDefaultSource = (outboxUrl: string): LofiRuntimeSource => ({
  id: "default",
  outboxUrl,
});

export const createLofiRuntime = (options: LofiRuntimeOptions): LofiRuntime => {
  const sources =
    options.sources ?? (options.outboxUrl ? [getDefaultSource(options.outboxUrl)] : []);
  if (sources.length === 0) {
    throw new Error("createLofiRuntime requires at least one source or outboxUrl.");
  }

  const bootstrapEnabled = options.bootstrap ?? true;
  let running = false;
  const $status = atom<LofiRuntimeStatus>(
    createInitialStatus(bootstrapEnabled ? "idle" : "bootstrapped"),
  );
  const $revision = atom(0);
  const sourceRuntimes = new Map<string, SourceRuntime>();
  const ephemeralTableKeys = new Set(
    options.ephemeralTables?.map(({ schema, table }) => `${schema}.${table}`) ?? [],
  );
  const hasRecoverableEphemeralStreams =
    options.ephemeralTables?.some(({ stream }) => stream !== undefined) ?? false;
  const ephemeralListeners = new Map<string, Set<(mutation: LofiMutation) => void>>();
  let retainCount = 0;
  let bootstrapPromise: Promise<LofiRuntimeSyncResult> | undefined;

  const updateStatus = (updater: (status: LofiRuntimeStatus) => LofiRuntimeStatus): void => {
    $status.set(updater($status.get()));
  };

  const getBootstrapMetaKey = (cursorKey: string): string => `${cursorKey}::bootstrap`;

  const sourceStatusValue = (status: LofiRuntimeSourceStatusValue): LofiRuntimeSourceStatusValue =>
    status;

  const sourceStatusDefaults = (): { status: LofiRuntimeSourceStatusValue } => ({
    status: bootstrapEnabled ? "idle" : "bootstrapped",
  });

  const getRuntimeStatus = (sources: LofiRuntimeStatus["sources"]): LofiRuntimeStatusValue => {
    const sourceStatuses = Object.values(sources);

    if (sourceStatuses.some((source) => source.status === "bootstrapping")) {
      return "bootstrapping";
    }

    if (sourceStatuses.some((source) => source.status === "syncing")) {
      return "syncing";
    }

    if (running) {
      return "running";
    }

    if (
      !bootstrapEnabled ||
      (sourceStatuses.length > 0 &&
        sourceStatuses.every((source) => source.status === "bootstrapped"))
    ) {
      return "bootstrapped";
    }

    return "idle";
  };

  const isBootstrapped = (): boolean =>
    !bootstrapEnabled || isLofiRuntimeBootstrapped($status.get());

  const markSourceSyncing = (sourceId: string, syncing: boolean): void => {
    updateStatus((current) => {
      const sources: LofiRuntimeStatus["sources"] = {
        ...current.sources,
        [sourceId]: {
          ...sourceStatusDefaults(),
          ...current.sources[sourceId],
          status: sourceStatusValue(
            syncing
              ? current.sources[sourceId]?.status === "bootstrapping"
                ? "bootstrapping"
                : "syncing"
              : (current.sources[sourceId]?.status ?? "idle"),
          ),
        },
      };

      return {
        ...current,
        status: getRuntimeStatus(sources),
        sources,
      };
    });
  };

  const markSourceResult = (sourceId: string, result: LofiSyncResult): void => {
    const now = Date.now();
    updateStatus((current) => {
      const sources: LofiRuntimeStatus["sources"] = {
        ...current.sources,
        [sourceId]: {
          ...sourceStatusDefaults(),
          ...current.sources[sourceId],
          status: sourceStatusValue(
            current.sources[sourceId]?.status === "bootstrapping"
              ? "bootstrapping"
              : "bootstrapped",
          ),
          lastSyncAt: now,
          lastVersionstamp: result.lastVersionstamp ?? current.sources[sourceId]?.lastVersionstamp,
          lastError: undefined,
        },
      };

      return {
        ...current,
        status: getRuntimeStatus(sources),
        lastSyncAt: now,
        lastVersionstamp: result.lastVersionstamp ?? current.lastVersionstamp,
        ...(result.appliedEntries > 0 ? { lastAppliedSourceId: sourceId } : {}),
        lastError: undefined,
        sources,
      };
    });
  };

  const markSourceError = (sourceId: string, error: unknown): void => {
    updateStatus((current) => {
      const sources: LofiRuntimeStatus["sources"] = {
        ...current.sources,
        [sourceId]: {
          ...sourceStatusDefaults(),
          ...current.sources[sourceId],
          status: sourceStatusValue(
            current.sources[sourceId]?.status === "bootstrapped" ? "bootstrapped" : "idle",
          ),
          lastError: error,
        },
      };

      return {
        ...current,
        status: getRuntimeStatus(sources),
        lastError: error,
        sources,
      };
    });
  };

  const markSourceBootstrapping = (sourceId: string): void => {
    updateStatus((current) => {
      const sources: LofiRuntimeStatus["sources"] = {
        ...current.sources,
        [sourceId]: {
          ...sourceStatusDefaults(),
          ...current.sources[sourceId],
          status: sourceStatusValue("bootstrapping"),
        },
      };

      return {
        ...current,
        status: getRuntimeStatus(sources),
        sources,
      };
    });
  };

  const markSourceBootstrapped = (sourceId: string): void => {
    updateStatus((status) => {
      const sources: LofiRuntimeStatus["sources"] = {
        ...status.sources,
        [sourceId]: {
          ...sourceStatusDefaults(),
          ...status.sources[sourceId],
          status: sourceStatusValue("bootstrapped"),
        },
      };

      return {
        ...status,
        status: getRuntimeStatus(sources),
        sources,
      };
    });
  };

  const markSourceBootstrapIdle = (sourceId: string): void => {
    updateStatus((status) => {
      const sources: LofiRuntimeStatus["sources"] = {
        ...status.sources,
        [sourceId]: {
          ...sourceStatusDefaults(),
          ...status.sources[sourceId],
          status: sourceStatusValue(
            status.sources[sourceId]?.status === "bootstrapped" ? "bootstrapped" : "idle",
          ),
        },
      };

      return {
        ...status,
        status: getRuntimeStatus(sources),
        sources,
      };
    });
  };

  const refresh = (): void => {
    $revision.set($revision.get() + 1);
  };

  const isEphemeralTable = (schema: string, table: string): boolean =>
    ephemeralTableKeys.has(`${schema}.${table}`);

  const subscribeEphemeral: LofiRuntime["subscribeEphemeral"] = (schema, table, listener) => {
    const key = `${schema.name}.${table}`;
    if (!ephemeralTableKeys.has(key)) {
      throw new Error(`Lofi table is not configured as ephemeral: ${key}`);
    }

    let listeners = ephemeralListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      ephemeralListeners.set(key, listeners);
    }
    const untypedListener = listener as (mutation: LofiMutation) => void;
    listeners.add(untypedListener);
    const releaseRuntime = retain();

    for (const source of sourceRuntimes.values()) {
      source.client.replayEphemeral(({ mutations }) => {
        for (const mutation of mutations) {
          if (`${mutation.schema}.${mutation.table}` === key) {
            untypedListener(mutation);
          }
        }
      });
    }

    return () => {
      listeners.delete(untypedListener);
      if (listeners.size === 0) {
        ephemeralListeners.delete(key);
      }
      releaseRuntime();
    };
  };

  const emitEphemeralMutations = (mutations: readonly LofiMutation[]): void => {
    for (const mutation of mutations) {
      const listeners = ephemeralListeners.get(`${mutation.schema}.${mutation.table}`);
      if (!listeners) {
        continue;
      }
      for (const listener of listeners) {
        listener(mutation);
      }
    }
  };

  const createSourceRuntime = (source: LofiRuntimeSource): SourceRuntime => {
    if (!source.id || source.id.trim().length === 0) {
      throw new Error("Lofi runtime sources require a non-empty id.");
    }

    const cursorKey = source.cursorKey ?? `${options.endpointName}:${source.id}:outbox`;
    const commonClientOptions = {
      endpointName: options.endpointName,
      outboxUrl: source.outboxUrl,
      adapter: options.adapter,
      cursorKey,
      limit: source.limit ?? options.limit,
      ephemeralTables: options.ephemeralTables,
      fetch: options.fetch,
      signal: options.signal,
      onSyncComplete: (result: LofiSyncResult) => {
        markSourceResult(source.id, result);
        if ((result.appliedDurableMutations ?? result.appliedEntries) > 0) {
          refresh();
        }
      },
      onError: (error: unknown) => {
        markSourceError(source.id, error);
      },
    };
    const outboxTransport = source.outboxTransport ?? options.outboxTransport ?? "poll";
    const clientOptions: LofiClientOptions =
      outboxTransport === "stream"
        ? {
            ...commonClientOptions,
            outboxTransport: "stream",
            outboxStreamUrl: source.outboxStreamUrl,
            streamReconnectIntervalMs:
              source.streamReconnectIntervalMs ?? options.streamReconnectIntervalMs,
          }
        : {
            ...commonClientOptions,
            outboxTransport: "poll",
            pollIntervalMs: source.pollIntervalMs ?? options.pollIntervalMs,
          };

    const client = new LofiClient(clientOptions);
    client.subscribeEphemeral(({ mutations }) => {
      emitEphemeralMutations(mutations);
    });
    return { source, cursorKey, client };
  };

  const addSource = (source: LofiRuntimeSource): void => {
    if (sourceRuntimes.has(source.id)) {
      throw new Error(`Lofi runtime source already exists: ${source.id}`);
    }

    const runtime = createSourceRuntime(source);
    sourceRuntimes.set(source.id, runtime);
    updateStatus((status) => {
      const sources: LofiRuntimeStatus["sources"] = {
        ...status.sources,
        [source.id]: status.sources[source.id] ?? sourceStatusDefaults(),
      };

      return {
        ...status,
        status: getRuntimeStatus(sources),
        sources,
      };
    });

    if (running) {
      if (bootstrapEnabled) {
        const addedSourceBootstrap = bootstrapPromise
          ? bootstrapPromise.then(() => bootstrap(source.id))
          : bootstrap(source.id);
        void addedSourceBootstrap.then(() => {
          if (running && sourceRuntimes.has(source.id)) {
            runtime.client.start({ signal: options.signal });
          }
        });
      } else {
        runtime.client.start({ signal: options.signal });
      }
    }
  };

  const removeSource = (sourceId: string): void => {
    const source = sourceRuntimes.get(sourceId);
    if (!source) {
      return;
    }

    source.client.stop();
    sourceRuntimes.delete(sourceId);
    updateStatus((status) => {
      const nextSources = { ...status.sources };
      delete nextSources[sourceId];
      return {
        ...status,
        status: getRuntimeStatus(nextSources),
        sources: nextSources,
      };
    });
  };

  const startLiveClients = (): void => {
    for (const runtime of sourceRuntimes.values()) {
      runtime.client.start({ signal: options.signal });
    }
  };

  const start = (): void => {
    if (running) {
      return;
    }

    running = true;
    updateStatus((current) => ({ ...current, status: getRuntimeStatus(current.sources) }));

    if (!bootstrapEnabled) {
      startLiveClients();
      return;
    }

    void bootstrap()
      .then(() => {
        if (running) {
          startLiveClients();
        }
      })
      .catch((error: unknown) => {
        running = false;
        updateStatus((current) => ({ ...current, status: getRuntimeStatus(current.sources) }));
        throw error;
      });
  };

  const stop = (): void => {
    for (const runtime of sourceRuntimes.values()) {
      runtime.client.stop();
    }
    running = false;
    updateStatus((current) => {
      const sources: LofiRuntimeStatus["sources"] = Object.fromEntries(
        Object.entries(current.sources).map(([sourceId, source]) => [
          sourceId,
          {
            ...source,
            status: sourceStatusValue(source.status === "bootstrapped" ? "bootstrapped" : "idle"),
          },
        ]),
      );

      return {
        ...current,
        status: getRuntimeStatus(sources),
        sources,
      };
    });
  };

  const retain = (): (() => void) => {
    retainCount += 1;
    if (retainCount === 1) {
      start();
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      retainCount = Math.max(0, retainCount - 1);
      if (retainCount === 0 && !options.keepAlive) {
        stop();
      }
    };
  };

  const syncSourceOnce = async (
    sourceId: string,
    syncOptions?: { deliverEphemeral?: boolean },
  ): Promise<LofiSyncResult> => {
    const runtime = sourceRuntimes.get(sourceId);
    if (!runtime) {
      throw new Error(`Unknown Lofi runtime source: ${sourceId}`);
    }

    markSourceSyncing(sourceId, true);
    try {
      const result = await runtime.client.syncOnce({
        signal: options.signal,
        deliverEphemeral: syncOptions?.deliverEphemeral,
      });
      if (result.aborted) {
        markSourceBootstrapIdle(sourceId);
        return result;
      }

      markSourceResult(sourceId, result);
      return result;
    } catch (error) {
      markSourceError(sourceId, error);
      throw error;
    }
  };

  const summarizeSyncResults = (
    sourceResults: Record<string, LofiSyncResult>,
  ): LofiRuntimeSyncResult => {
    const results = Object.values(sourceResults);
    return {
      appliedEntries: results.reduce((total, result) => total + result.appliedEntries, 0),
      lastVersionstamp: results.findLast((result) => result.lastVersionstamp)?.lastVersionstamp,
      sources: sourceResults,
    };
  };

  const syncOnce = async (sourceId?: string): Promise<LofiRuntimeSyncResult> => {
    const sourceResults: Record<string, LofiSyncResult> = {};
    const targetSourceIds = sourceId ? [sourceId] : [...sourceRuntimes.keys()];

    for (const targetSourceId of targetSourceIds) {
      sourceResults[targetSourceId] = await syncSourceOnce(targetSourceId);
    }

    return summarizeSyncResults(sourceResults);
  };

  const bootstrapSource = async (sourceId: string): Promise<LofiSyncResult> => {
    const runtime = sourceRuntimes.get(sourceId);
    if (!runtime) {
      throw new Error(`Unknown Lofi runtime source: ${sourceId}`);
    }

    markSourceBootstrapping(sourceId);
    const bootstrapMetaKey = getBootstrapMetaKey(runtime.cursorKey);
    const bootstrapStatus = await options.adapter.getMeta(bootstrapMetaKey);

    if (bootstrapStatus === "complete" && !hasRecoverableEphemeralStreams) {
      markSourceBootstrapped(sourceId);
      return {
        appliedEntries: 0,
        lastVersionstamp: await options.adapter.getMeta(runtime.cursorKey),
      };
    }

    try {
      // Catch-up rebuilds active stream buffers without sending historical rows to mounted stores.
      const result = await syncSourceOnce(sourceId, { deliverEphemeral: false });
      if (result.aborted) {
        throw createAbortError();
      }

      runtime.client.replayEphemeral(({ mutations }) => emitEphemeralMutations(mutations));
      if (bootstrapStatus !== "complete") {
        await options.adapter.setMeta(bootstrapMetaKey, "complete");
      }
      markSourceBootstrapped(sourceId);
      return result;
    } catch (error) {
      if (isAbortError(error)) {
        markSourceBootstrapIdle(sourceId);
      } else {
        markSourceError(sourceId, error);
      }
      throw error;
    }
  };

  const runBootstrap = async (): Promise<LofiRuntimeSyncResult> => {
    if (!bootstrapEnabled) {
      return summarizeSyncResults({});
    }

    const sourceResults: Record<string, LofiSyncResult> = {};
    for (const sourceId of sourceRuntimes.keys()) {
      sourceResults[sourceId] = await bootstrapSource(sourceId);
    }
    return summarizeSyncResults(sourceResults);
  };

  const bootstrap = (sourceId?: string): Promise<LofiRuntimeSyncResult> => {
    if (!bootstrapEnabled) {
      return Promise.resolve(summarizeSyncResults({}));
    }

    if (sourceId) {
      const sourceStatus = $status.get().sources[sourceId];
      if (sourceStatus?.status === "bootstrapped") {
        return Promise.resolve(summarizeSyncResults({}));
      }
      return bootstrapSource(sourceId).then((result) =>
        summarizeSyncResults({ [sourceId]: result }),
      );
    }

    if (isBootstrapped()) {
      return Promise.resolve(summarizeSyncResults({}));
    }

    if (bootstrapPromise) {
      return bootstrapPromise;
    }

    bootstrapPromise = runBootstrap().finally(() => {
      bootstrapPromise = undefined;
    });
    return bootstrapPromise;
  };

  const whenBootstrapped = async (): Promise<void> => {
    if (!bootstrapEnabled || isBootstrapped()) {
      return;
    }

    await bootstrap();
  };

  for (const source of sources) {
    addSource(source);
  }

  const tx: LofiRuntimeTxFactory = () =>
    createLofiRuntimeTx({
      adapter: options.adapter,
      whenBootstrapped,
    });
  let runtime: LofiRuntime;
  const store: LofiRuntimeStoreFactory = () => createLofiRuntimeStore(runtime);

  runtime = {
    endpointName: options.endpointName,
    adapter: options.adapter,
    isEphemeralTable,
    subscribeEphemeral,
    $status,
    $revision,
    start,
    stop,
    retain,
    bootstrap,
    whenBootstrapped,
    syncOnce,
    refresh,
    tx,
    store,
    addSource,
    removeSource,
  };

  if (options.autoStart) {
    start();
  }

  return runtime;
};

const createAbortError = (): Error => {
  const error = new Error("Lofi bootstrap aborted.");
  error.name = "AbortError";
  return error;
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";
