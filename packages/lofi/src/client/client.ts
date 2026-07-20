import type { OutboxEntry, OutboxPayload } from "@fragno-dev/db";

import { decodeOutboxPayload, resolveOutboxRefs } from "../outbox";
import { assertNoUnresolvedDbNowMutations } from "../query/mutation-values";
import type {
  LofiClientOptions,
  LofiEphemeralMutationBatch,
  LofiEphemeralStreamPolicy,
  LofiMutation,
  LofiOutboxTransport,
  LofiSyncResult,
} from "../types";

type LofiSyncOptions = {
  signal?: AbortSignal;
  /** Builds replay buffers without delivering historical ephemeral mutations to live listeners. */
  deliverEphemeral?: boolean;
};

type OutboxPageResult = {
  entries: OutboxEntry[];
  lastVersionstamp?: string;
};

type OutboxFetchOptions = {
  cursor?: string;
  limit: number;
  signal: AbortSignal;
};

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LIMIT = 500;

const ephemeralTableKey = (schema: string, table: string): string => `${schema}.${table}`;

type BufferedEphemeralMutation = {
  order: number;
  batch: LofiEphemeralMutationBatch;
};

type ActiveEphemeralStream = {
  key: string;
  startedAfterVersionstamp: string | undefined;
  startOrder: number;
  mutations: BufferedEphemeralMutation[];
  mutationVersionstamps: Set<string>;
};

export class LofiClient {
  private readonly adapter: LofiClientOptions["adapter"];
  private readonly outboxUrl: string;
  private readonly outboxStreamUrl: string;
  private readonly endpointName: string;
  private readonly fetcher: typeof fetch;
  private readonly outboxTransport: LofiOutboxTransport;
  private readonly pollIntervalMs: number;
  private readonly streamReconnectIntervalMs: number;
  private readonly limit: number;
  private readonly cursorKey?: string;
  private readonly ephemeralTableKeys: ReadonlySet<string>;
  private readonly ephemeralStreamPolicies: ReadonlyMap<string, LofiEphemeralStreamPolicy>;
  private readonly ephemeralListeners = new Set<(batch: LofiEphemeralMutationBatch) => void>();
  private readonly activeEphemeralStreams = new Map<string, ActiveEphemeralStream>();
  private readonly onSyncApplied?: (result: LofiSyncResult) => void | Promise<void>;
  private readonly onSyncComplete?: (result: LofiSyncResult) => void | Promise<void>;
  private readonly onError?: (error: unknown) => void;
  private readonly defaultSignal?: AbortSignal;

  private intervalId: ReturnType<typeof setInterval> | undefined;
  private inFlight?: Promise<LofiSyncResult>;
  private inFlightController?: AbortController;
  private streamController?: AbortController;
  private streamPromise?: Promise<void>;
  private loopSignal?: AbortSignal;
  private loopSignalListener?: () => void;
  private running = false;
  private readCursor: string | undefined;
  private readCursorInitialized = false;
  private nextEphemeralMutationOrder = 0;
  private readonly pendingDurableMutationCountsByVersionstamp = new Map<string, number>();

  constructor(options: LofiClientOptions) {
    this.adapter = options.adapter;
    this.outboxUrl = options.outboxUrl;
    this.outboxStreamUrl = options.outboxStreamUrl ?? buildOutboxStreamUrl(options.outboxUrl);
    this.endpointName = options.endpointName;
    const defaultFetch = fetch.bind(globalThis);
    this.fetcher = options.fetch ?? defaultFetch;
    this.outboxTransport = options.outboxTransport ?? "poll";
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.streamReconnectIntervalMs = options.streamReconnectIntervalMs ?? this.pollIntervalMs;
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.cursorKey = options.cursorKey;
    this.ephemeralTableKeys = new Set(
      options.ephemeralTables?.map(({ schema, table }) => ephemeralTableKey(schema, table)) ?? [],
    );
    this.ephemeralStreamPolicies = new Map(
      options.ephemeralTables?.flatMap(({ schema, table, stream }) =>
        stream ? [[ephemeralTableKey(schema, table), stream] as const] : [],
      ) ?? [],
    );
    this.onSyncApplied = options.onSyncApplied;
    this.onSyncComplete = options.onSyncComplete;
    this.onError = options.onError;
    this.defaultSignal = options.signal;
  }

  subscribeEphemeral(listener: (batch: LofiEphemeralMutationBatch) => void): () => void {
    this.ephemeralListeners.add(listener);
    return () => {
      this.ephemeralListeners.delete(listener);
    };
  }

  /** Replays every currently active ephemeral stream in original mutation order. */
  replayEphemeral(listener: (batch: LofiEphemeralMutationBatch) => void): void {
    const buffered = [...this.activeEphemeralStreams.values()]
      .flatMap((stream) => stream.mutations)
      .sort((left, right) => left.order - right.order);
    for (const item of buffered) {
      listener(item.batch);
    }
  }

  start(options?: { signal?: AbortSignal }): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.loopSignal = options?.signal ?? this.defaultSignal;

    if (this.loopSignal?.aborted) {
      this.running = false;
      this.loopSignal = undefined;
      return;
    }

    if (this.loopSignal) {
      const abortListener = () => {
        this.stop();
      };
      this.loopSignal.addEventListener("abort", abortListener, { once: true });
      this.loopSignalListener = () => this.loopSignal?.removeEventListener("abort", abortListener);
    }

    if (this.outboxTransport === "stream") {
      this.startStreamLoop();
      return;
    }

    void this.syncOnce({ signal: this.loopSignal }).catch((error: unknown) => {
      if (isAbortError(error)) {
        return;
      }

      this.handleLoopError(error);
    });

    this.intervalId = setInterval(() => {
      if (!this.intervalId) {
        return;
      }

      if (this.inFlight) {
        return;
      }

      void this.syncOnce({ signal: this.loopSignal }).catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }

        this.handleLoopError(error);
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    if (this.loopSignalListener) {
      this.loopSignalListener();
      this.loopSignalListener = undefined;
    }

    const streamController = this.streamController;
    this.streamController = undefined;
    this.streamPromise = undefined;

    this.loopSignal = undefined;
    this.inFlightController?.abort();
    streamController?.abort();
  }

  async syncOnce(options?: LofiSyncOptions): Promise<LofiSyncResult> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const signal = options?.signal ?? this.defaultSignal;
    if (signal?.aborted) {
      return { appliedEntries: 0, aborted: true };
    }

    const controller = new AbortController();
    this.inFlightController = controller;
    const cleanup = attachAbortSignal(controller, signal);

    const promise = this.runSyncOnce(controller.signal, options?.deliverEphemeral ?? true).finally(
      () => {
        cleanup();
        if (this.inFlight === promise) {
          this.inFlight = undefined;
        }
        if (this.inFlightController === controller) {
          this.inFlightController = undefined;
        }
      },
    );

    this.inFlight = promise;
    return promise;
  }

  private async runSyncOnce(
    signal: AbortSignal,
    deliverEphemeral: boolean,
  ): Promise<LofiSyncResult> {
    if (signal.aborted) {
      return { appliedEntries: 0, aborted: true };
    }

    const cursorKey = this.cursorKey ?? `${this.endpointName}::outbox`;
    const sourceKey = cursorKey;
    let cursor = await this.getReadCursor(cursorKey);

    let appliedEntries = 0;
    let appliedDurableMutations = 0;
    let lastVersionstamp: string | undefined;

    const currentResult = (aborted?: true): LofiSyncResult => ({
      appliedEntries,
      lastVersionstamp,
      ...(this.ephemeralTableKeys.size > 0 ? { appliedDurableMutations } : {}),
      ...(aborted ? { aborted } : {}),
    });

    try {
      for await (const page of this.fetchPages({ cursor, limit: this.limit, signal })) {
        if (page.entries.length === 0) {
          break;
        }

        for (const entry of page.entries) {
          if (signal.aborted) {
            return currentResult(true);
          }

          const result = await this.applyEntry({
            entry,
            cursorKey,
            sourceKey,
            previousReadCursor: cursor,
            deliverEphemeral,
          });

          lastVersionstamp = result.lastVersionstamp;
          cursor = result.lastVersionstamp;

          if (result.applied) {
            appliedEntries += 1;
            appliedDurableMutations += result.appliedDurableMutations;
          }

          if (signal.aborted) {
            return currentResult(true);
          }
        }

        if (page.entries.length < this.limit) {
          break;
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        return currentResult(true);
      }
      throw error;
    }

    if (signal.aborted) {
      return currentResult(true);
    }

    const result = currentResult();

    if (appliedEntries > 0) {
      await this.onSyncApplied?.(result);
    }
    await this.onSyncComplete?.(result);

    return result;
  }

  private startStreamLoop(): void {
    if (this.streamPromise) {
      return;
    }

    const controller = new AbortController();
    this.streamController = controller;
    const cleanup = attachAbortSignal(controller, this.loopSignal);

    const promise = this.runStreamLoop(controller.signal)
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }

        this.handleLoopError(error);
      })
      .finally(() => {
        cleanup();
        if (this.streamPromise === promise) {
          this.streamPromise = undefined;
        }
        if (this.streamController === controller) {
          this.streamController = undefined;
        }
      });

    this.streamPromise = promise;
  }

  private async runStreamLoop(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }

    const cursorKey = this.cursorKey ?? `${this.endpointName}::outbox`;
    const sourceKey = cursorKey;

    while (!signal.aborted) {
      let cursor = await this.getReadCursor(cursorKey);

      try {
        const response = await this.fetcher(
          buildOutboxUrl(this.outboxStreamUrl, cursor, this.limit),
          { signal },
        );

        if (!response.ok) {
          throw new Error(
            `Outbox stream request failed: ${response.status} ${response.statusText}`,
          );
        }

        for await (const entry of parseOutboxEntryStream(response, signal)) {
          if (signal.aborted) {
            return;
          }

          const result = await this.applyEntry({
            entry,
            cursorKey,
            sourceKey,
            previousReadCursor: cursor,
            deliverEphemeral: true,
          });
          cursor = result.lastVersionstamp;
          const syncResult: LofiSyncResult = {
            appliedEntries: result.applied ? 1 : 0,
            lastVersionstamp: result.lastVersionstamp,
            ...(this.ephemeralTableKeys.size > 0
              ? { appliedDurableMutations: result.appliedDurableMutations }
              : {}),
          };

          if (result.applied) {
            await this.onSyncApplied?.(syncResult);
          }
          await this.onSyncComplete?.(syncResult);
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          return;
        }

        if (!isReconnectableStreamError(error)) {
          throw error;
        }

        this.onError?.(error);
      }

      await sleep(this.streamReconnectIntervalMs, signal);
    }
  }

  private async applyEntry({
    entry,
    cursorKey,
    sourceKey,
    previousReadCursor,
    deliverEphemeral,
  }: {
    entry: OutboxEntry;
    cursorKey: string;
    sourceKey: string;
    previousReadCursor: string | undefined;
    deliverEphemeral: boolean;
  }): Promise<{
    applied: boolean;
    appliedDurableMutations: number;
    lastVersionstamp: string;
  }> {
    const mutations = decodeOutboxEntry(entry);
    const refResolvedMutations = entry.refMap
      ? mutations.map((mutation) => resolveOutboxRefs(mutation, entry.refMap ?? {}))
      : mutations;
    assertNoUnresolvedDbNowMutations(refResolvedMutations);
    const resolvedMutations = refResolvedMutations;
    const durableMutations: LofiMutation[] = [];
    const ephemeralMutations: LofiMutation[] = [];
    for (const mutation of resolvedMutations) {
      const target = this.ephemeralTableKeys.has(ephemeralTableKey(mutation.schema, mutation.table))
        ? ephemeralMutations
        : durableMutations;
      target.push(mutation);
    }

    const durableResult =
      durableMutations.length > 0
        ? await this.adapter.applyOutboxEntry({
            sourceKey,
            versionstamp: entry.versionstamp,
            uowId: entry.uowId,
            mutations: durableMutations,
          })
        : { applied: true };
    if (durableResult.applied && durableMutations.length > 0) {
      this.pendingDurableMutationCountsByVersionstamp.set(
        entry.versionstamp,
        durableMutations.length,
      );
    }

    if (ephemeralMutations.length > 0) {
      const batch = {
        sourceKey,
        uowId: entry.uowId,
        versionstamp: entry.versionstamp,
        mutations: ephemeralMutations,
      } satisfies LofiEphemeralMutationBatch;

      const streamActions = ephemeralMutations.flatMap((mutation) => {
        const tableKey = ephemeralTableKey(mutation.schema, mutation.table);
        const policy = this.ephemeralStreamPolicies.get(tableKey);
        if (!policy || mutation.op !== "create") {
          return [];
        }
        return [
          {
            mutation,
            streamKey: `${tableKey}:${policy.key(mutation.values)}`,
            boundary: policy.boundary(mutation.values),
          },
        ];
      });

      if (deliverEphemeral) {
        for (const listener of this.ephemeralListeners) {
          listener(batch);
        }
      }

      for (const action of streamActions) {
        if (action.boundary === "start") {
          const order = this.nextEphemeralMutationOrder++;
          this.activeEphemeralStreams.set(action.streamKey, {
            key: action.streamKey,
            startedAfterVersionstamp: previousReadCursor,
            startOrder: order,
            mutations: [
              {
                order,
                batch: { ...batch, mutations: [action.mutation] },
              },
            ],
            mutationVersionstamps: new Set([action.mutation.versionstamp]),
          });
        } else if (action.boundary === "item") {
          const stream = this.activeEphemeralStreams.get(action.streamKey);
          if (stream && !stream.mutationVersionstamps.has(action.mutation.versionstamp)) {
            stream.mutationVersionstamps.add(action.mutation.versionstamp);
            stream.mutations.push({
              order: this.nextEphemeralMutationOrder++,
              batch: { ...batch, mutations: [action.mutation] },
            });
          }
        } else {
          this.activeEphemeralStreams.delete(action.streamKey);
        }
      }
    }

    const safeCheckpoint = this.getSafeCheckpoint(entry.versionstamp);
    if (safeCheckpoint !== undefined) {
      await this.adapter.setMeta(cursorKey, safeCheckpoint);
    }
    this.readCursor = entry.versionstamp;
    this.readCursorInitialized = true;

    const appliedDurableMutations =
      this.pendingDurableMutationCountsByVersionstamp.get(entry.versionstamp) ?? 0;
    this.pendingDurableMutationCountsByVersionstamp.delete(entry.versionstamp);

    return {
      applied: durableResult.applied || ephemeralMutations.length > 0,
      appliedDurableMutations,
      lastVersionstamp: entry.versionstamp,
    };
  }

  private async getReadCursor(cursorKey: string): Promise<string | undefined> {
    if (!this.readCursorInitialized) {
      this.readCursor = await this.adapter.getMeta(cursorKey);
      this.readCursorInitialized = true;
    }
    return this.readCursor;
  }

  private getSafeCheckpoint(currentVersionstamp: string): string | undefined {
    let earliest: ActiveEphemeralStream | undefined;
    for (const stream of this.activeEphemeralStreams.values()) {
      if (!earliest || stream.startOrder < earliest.startOrder) {
        earliest = stream;
      }
    }
    return (
      earliest?.startedAfterVersionstamp ??
      (this.activeEphemeralStreams.size === 0 ? currentVersionstamp : undefined)
    );
  }

  private async *fetchPages(options: OutboxFetchOptions): AsyncGenerator<OutboxPageResult> {
    let cursor = options.cursor;

    while (true) {
      if (options.signal.aborted) {
        return;
      }

      const url = buildOutboxUrl(this.outboxUrl, cursor, options.limit);
      const response = await this.fetcher(url, { signal: options.signal });

      if (!response.ok) {
        throw new Error(`Outbox request failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as OutboxEntry[];
      if (!Array.isArray(data)) {
        throw new Error("Invalid outbox response payload");
      }

      const lastVersionstamp = data.at(-1)?.versionstamp;
      yield { entries: data, lastVersionstamp };

      if (data.length < options.limit || !lastVersionstamp) {
        return;
      }

      cursor = lastVersionstamp;
    }
  }

  private handleLoopError(error: unknown): void {
    this.stop();
    this.onError?.(error);
  }
}

function decodeOutboxEntry(entry: OutboxEntry): LofiMutation[] {
  const payload = decodeOutboxPayload(entry.payload);
  return payload.mutations.map((mutation) => toLofiMutation(mutation));
}

function toLofiMutation(mutation: OutboxPayload["mutations"][number]): LofiMutation {
  if (mutation.op === "create") {
    return {
      op: "create",
      schema: mutation.schema,
      table: mutation.table,
      externalId: mutation.externalId,
      values: mutation.values,
      versionstamp: mutation.versionstamp,
    };
  }

  if (mutation.op === "update") {
    return {
      op: "update",
      schema: mutation.schema,
      table: mutation.table,
      externalId: mutation.externalId,
      set: mutation.set,
      versionstamp: mutation.versionstamp,
    };
  }

  return {
    op: "delete",
    schema: mutation.schema,
    table: mutation.table,
    externalId: mutation.externalId,
    versionstamp: mutation.versionstamp,
  };
}

async function* parseOutboxEntryStream(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<OutboxEntry> {
  if (!response.body) {
    throw new Error("Invalid outbox stream response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  try {
    while (!signal.aborted) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          throw error;
        }
        throw new OutboxStreamReadError(error);
      }

      const { done, value } = chunk;
      if (done) {
        completed = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        yield JSON.parse(line) as OutboxEntry;
      }
    }

    if (!signal.aborted && buffer.trim().length > 0) {
      yield JSON.parse(buffer) as OutboxEntry;
    }
  } finally {
    if (!completed) {
      await reader.cancel();
    }
    reader.releaseLock();
  }
}

class OutboxStreamReadError extends Error {
  readonly originalError: unknown;

  constructor(cause: unknown) {
    super("Outbox stream read failed");
    this.name = "OutboxStreamReadError";
    this.originalError = cause;
  }
}

function buildOutboxUrl(outboxUrl: string, afterVersionstamp: string | undefined, limit: number) {
  const url = new URL(outboxUrl, getUrlBase());
  const params = new URLSearchParams(url.search);

  if (afterVersionstamp) {
    params.set("afterVersionstamp", afterVersionstamp);
  } else {
    params.delete("afterVersionstamp");
  }

  params.set("limit", String(limit));
  url.search = params.toString();

  return url.toString();
}

function buildOutboxStreamUrl(outboxUrl: string): string {
  const url = new URL(outboxUrl, getUrlBase());
  const pathname = url.pathname.replace(/\/+$/, "");

  if (pathname.endsWith("/_internal/outbox/stream")) {
    url.pathname = pathname;
    return url.toString();
  }

  url.pathname = `${pathname}/stream`;
  return url.toString();
}

function getUrlBase(): string | undefined {
  if (typeof globalThis.location?.href === "string") {
    return globalThis.location.href;
  }

  return "http://localhost";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function attachAbortSignal(controller: AbortController, signal?: AbortSignal) {
  if (!signal) {
    return () => undefined;
  }

  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }

  const abort = () => {
    controller.abort(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  return () => {
    signal.removeEventListener("abort", abort);
  };
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "name" in error && error.name === "AbortError";
}

function isReconnectableStreamError(error: unknown): boolean {
  return error instanceof OutboxStreamReadError || error instanceof TypeError;
}
