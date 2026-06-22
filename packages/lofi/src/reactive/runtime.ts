import { atom, type ReadableAtom } from "nanostores";

import { LofiClient } from "../client";
import type {
  LofiAdapter,
  LofiClientOptions,
  LofiQueryableAdapter,
  LofiSyncResult,
} from "../types";

export type LofiRuntimeSource = {
  id: string;
  outboxUrl: string;
  cursorKey?: string;
  pollIntervalMs?: number;
  limit?: number;
};

export type LofiRuntimeStatus = {
  running: boolean;
  syncing: boolean;
  lastSyncAt?: number;
  lastVersionstamp?: string;
  lastAppliedSourceId?: string;
  lastError?: unknown;
  sources: Record<
    string,
    {
      syncing: boolean;
      lastSyncAt?: number;
      lastVersionstamp?: string;
      lastError?: unknown;
    }
  >;
};

export type LofiRuntimeSyncResult = {
  appliedEntries: number;
  lastVersionstamp?: string;
  sources: Record<string, LofiSyncResult>;
};

export type LofiRuntimeOptions = {
  endpointName: string;
  adapter: LofiAdapter & LofiQueryableAdapter;
  sources?: LofiRuntimeSource[];
  outboxUrl?: string;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  limit?: number;
  signal?: AbortSignal;
  autoStart?: boolean;
  keepAlive?: boolean;
};

export type LofiRuntime = {
  endpointName: string;
  adapter: LofiAdapter & LofiQueryableAdapter;
  $status: ReadableAtom<LofiRuntimeStatus>;
  $revision: ReadableAtom<number>;
  start: () => void;
  stop: () => void;
  retain: () => () => void;
  syncOnce: (sourceId?: string) => Promise<LofiRuntimeSyncResult>;
  refresh: () => void;
  addSource: (source: LofiRuntimeSource) => void;
  removeSource: (sourceId: string) => void;
};

type SourceRuntime = {
  source: LofiRuntimeSource;
  client: LofiClient;
};

const createInitialStatus = (): LofiRuntimeStatus => ({
  running: false,
  syncing: false,
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

  const $status = atom<LofiRuntimeStatus>(createInitialStatus());
  const $revision = atom(0);
  const sourceRuntimes = new Map<string, SourceRuntime>();
  let retainCount = 0;

  const updateStatus = (updater: (status: LofiRuntimeStatus) => LofiRuntimeStatus): void => {
    $status.set(updater($status.get()));
  };

  const markSourceSyncing = (sourceId: string, syncing: boolean): void => {
    updateStatus((status) => ({
      ...status,
      syncing:
        syncing ||
        Object.entries(status.sources).some(([id, source]) => id !== sourceId && source.syncing),
      sources: {
        ...status.sources,
        [sourceId]: {
          ...status.sources[sourceId],
          syncing,
        },
      },
    }));
  };

  const markSourceResult = (sourceId: string, result: LofiSyncResult): void => {
    const now = Date.now();
    updateStatus((status) => ({
      ...status,
      syncing: Object.entries(status.sources).some(
        ([id, source]) => id !== sourceId && source.syncing,
      ),
      lastSyncAt: now,
      lastVersionstamp: result.lastVersionstamp ?? status.lastVersionstamp,
      ...(result.appliedEntries > 0 ? { lastAppliedSourceId: sourceId } : {}),
      lastError: undefined,
      sources: {
        ...status.sources,
        [sourceId]: {
          ...status.sources[sourceId],
          syncing: false,
          lastSyncAt: now,
          lastVersionstamp: result.lastVersionstamp ?? status.sources[sourceId]?.lastVersionstamp,
          lastError: undefined,
        },
      },
    }));
  };

  const markSourceError = (sourceId: string, error: unknown): void => {
    updateStatus((status) => ({
      ...status,
      syncing: Object.entries(status.sources).some(
        ([id, source]) => id !== sourceId && source.syncing,
      ),
      lastError: error,
      sources: {
        ...status.sources,
        [sourceId]: {
          ...status.sources[sourceId],
          syncing: false,
          lastError: error,
        },
      },
    }));
  };

  const refresh = (): void => {
    $revision.set($revision.get() + 1);
  };

  const createSourceRuntime = (source: LofiRuntimeSource): SourceRuntime => {
    if (!source.id || source.id.trim().length === 0) {
      throw new Error("Lofi runtime sources require a non-empty id.");
    }

    const cursorKey = source.cursorKey ?? `${options.endpointName}:${source.id}:outbox`;
    const clientOptions: LofiClientOptions = {
      endpointName: options.endpointName,
      outboxUrl: source.outboxUrl,
      adapter: options.adapter,
      cursorKey,
      pollIntervalMs: source.pollIntervalMs ?? options.pollIntervalMs,
      limit: source.limit ?? options.limit,
      fetch: options.fetch,
      signal: options.signal,
      onSyncComplete: (result) => {
        markSourceResult(source.id, result);
        if (result.appliedEntries > 0) {
          refresh();
        }
      },
      onError: (error) => {
        markSourceError(source.id, error);
      },
    };

    return {
      source,
      client: new LofiClient(clientOptions),
    };
  };

  const addSource = (source: LofiRuntimeSource): void => {
    if (sourceRuntimes.has(source.id)) {
      throw new Error(`Lofi runtime source already exists: ${source.id}`);
    }

    const runtime = createSourceRuntime(source);
    sourceRuntimes.set(source.id, runtime);
    updateStatus((status) => ({
      ...status,
      sources: {
        ...status.sources,
        [source.id]: status.sources[source.id] ?? { syncing: false },
      },
    }));

    if ($status.get().running) {
      runtime.client.start({ signal: options.signal });
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
        syncing: Object.values(nextSources).some((entry) => entry.syncing),
        sources: nextSources,
      };
    });
  };

  const start = (): void => {
    const status = $status.get();
    if (status.running) {
      return;
    }

    updateStatus((current) => ({ ...current, running: true }));
    for (const runtime of sourceRuntimes.values()) {
      runtime.client.start({ signal: options.signal });
    }
  };

  const stop = (): void => {
    for (const runtime of sourceRuntimes.values()) {
      runtime.client.stop();
    }
    updateStatus((status) => ({ ...status, running: false, syncing: false }));
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

  const syncSourceOnce = async (sourceId: string): Promise<LofiSyncResult> => {
    const runtime = sourceRuntimes.get(sourceId);
    if (!runtime) {
      throw new Error(`Unknown Lofi runtime source: ${sourceId}`);
    }

    markSourceSyncing(sourceId, true);
    try {
      const result = await runtime.client.syncOnce({ signal: options.signal });
      markSourceResult(sourceId, result);
      return result;
    } catch (error) {
      markSourceError(sourceId, error);
      throw error;
    }
  };

  const syncOnce = async (sourceId?: string): Promise<LofiRuntimeSyncResult> => {
    const sourceResults: Record<string, LofiSyncResult> = {};
    const targetSourceIds = sourceId ? [sourceId] : [...sourceRuntimes.keys()];

    for (const targetSourceId of targetSourceIds) {
      sourceResults[targetSourceId] = await syncSourceOnce(targetSourceId);
    }

    const results = Object.values(sourceResults);
    return {
      appliedEntries: results.reduce((total, result) => total + result.appliedEntries, 0),
      lastVersionstamp: results.findLast((result) => result.lastVersionstamp)?.lastVersionstamp,
      sources: sourceResults,
    };
  };

  for (const source of sources) {
    addSource(source);
  }

  if (options.autoStart) {
    start();
  }

  return {
    endpointName: options.endpointName,
    adapter: options.adapter,
    $status,
    $revision,
    start,
    stop,
    retain,
    syncOnce,
    refresh,
    addSource,
    removeSource,
  };
};
