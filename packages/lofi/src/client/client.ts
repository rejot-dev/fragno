import type { OutboxEntry, OutboxPayload } from "@fragno-dev/db";
import { decodeOutboxPayload, resolveOutboxRefs } from "../outbox";
import type { LofiClientOptions, LofiMutation, LofiSyncResult } from "../types";

type LofiSyncOptions = { signal?: AbortSignal };

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

export class LofiClient {
  private readonly adapter: LofiClientOptions["adapter"];
  private readonly outboxUrl: string;
  private readonly endpointName: string;
  private readonly fetcher: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly limit: number;
  private readonly cursorKey?: string;
  private readonly onError?: (error: unknown) => void;
  private readonly defaultSignal?: AbortSignal;

  private intervalId: ReturnType<typeof setInterval> | undefined;
  private inFlight?: Promise<LofiSyncResult>;
  private inFlightController?: AbortController;
  private loopSignal?: AbortSignal;
  private loopSignalListener?: () => void;

  constructor(options: LofiClientOptions) {
    this.adapter = options.adapter;
    this.outboxUrl = options.outboxUrl;
    this.endpointName = options.endpointName;
    this.fetcher = options.fetch ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.cursorKey = options.cursorKey;
    this.onError = options.onError;
    this.defaultSignal = options.signal;
  }

  start(options?: { signal?: AbortSignal }): void {
    if (this.intervalId) {
      return;
    }

    this.loopSignal = options?.signal ?? this.defaultSignal;

    if (this.loopSignal) {
      const abortListener = () => this.stop();
      this.loopSignal.addEventListener("abort", abortListener, { once: true });
      this.loopSignalListener = () => this.loopSignal?.removeEventListener("abort", abortListener);
    }

    void this.syncOnce({ signal: this.loopSignal }).catch((error) => {
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

      void this.syncOnce({ signal: this.loopSignal }).catch((error) => {
        if (isAbortError(error)) {
          return;
        }

        this.handleLoopError(error);
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    if (this.loopSignalListener) {
      this.loopSignalListener();
      this.loopSignalListener = undefined;
    }

    this.loopSignal = undefined;
    this.inFlightController?.abort();
  }

  async syncOnce(options?: LofiSyncOptions): Promise<LofiSyncResult> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const signal = options?.signal ?? this.defaultSignal;
    if (signal?.aborted) {
      return { appliedEntries: 0 };
    }

    const controller = new AbortController();
    this.inFlightController = controller;
    const cleanup = attachAbortSignal(controller, signal);

    const promise = this.runSyncOnce(controller.signal).finally(() => {
      cleanup();
      if (this.inFlight === promise) {
        this.inFlight = undefined;
      }
      if (this.inFlightController === controller) {
        this.inFlightController = undefined;
      }
    });

    this.inFlight = promise;
    return promise;
  }

  private async runSyncOnce(signal: AbortSignal): Promise<LofiSyncResult> {
    if (signal.aborted) {
      return { appliedEntries: 0 };
    }

    const cursorKey = this.cursorKey ?? `${this.endpointName}::outbox`;
    const sourceKey = cursorKey;
    let cursor = await this.adapter.getMeta(cursorKey);

    let appliedEntries = 0;
    let lastVersionstamp: string | undefined;

    try {
      for await (const page of this.fetchPages({ cursor, limit: this.limit, signal })) {
        if (page.entries.length === 0) {
          break;
        }

        for (const entry of page.entries) {
          if (signal.aborted) {
            return { appliedEntries, lastVersionstamp };
          }

          const mutations = decodeOutboxEntry(entry);
          const resolvedMutations = entry.refMap
            ? mutations.map((mutation) => resolveOutboxRefs(mutation, entry.refMap ?? {}))
            : mutations;

          const result = await this.adapter.applyOutboxEntry({
            sourceKey,
            versionstamp: entry.versionstamp,
            mutations: resolvedMutations,
          });

          lastVersionstamp = entry.versionstamp;
          await this.adapter.setMeta(cursorKey, entry.versionstamp);
          cursor = entry.versionstamp;

          if (result.applied) {
            appliedEntries += 1;
          }

          if (signal.aborted) {
            return { appliedEntries, lastVersionstamp };
          }
        }

        if (page.entries.length < this.limit) {
          break;
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        return { appliedEntries, lastVersionstamp };
      }
      throw error;
    }

    return { appliedEntries, lastVersionstamp };
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

function buildOutboxUrl(outboxUrl: string, afterVersionstamp: string | undefined, limit: number) {
  const url = new URL(outboxUrl);
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

function attachAbortSignal(controller: AbortController, signal?: AbortSignal) {
  if (!signal) {
    return () => undefined;
  }

  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }

  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "name" in error && error.name === "AbortError";
}
