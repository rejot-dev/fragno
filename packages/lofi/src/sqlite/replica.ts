import { fetchFragnoInternalDescription, resolveFragnoInternalUrls } from "@fragno-dev/db/outbox";

import { LofiClient } from "../client/client";
import type {
  AnyLofiLocalProjection,
  LofiAdapter,
  LofiEphemeralTable,
  LofiSchemaRegistration,
} from "../types";
import { SqliteLofiAdapter, type LofiSqliteDatabase } from "./adapter";
import { LOFI_SQLITE_LAYOUT_VERSION, registeredSchemaName } from "./layout";
import {
  decodeLofiSqliteQueryRows,
  type LofiSqliteQuery,
  type LofiSqliteQueryRow,
  type LofiSqliteResultColumn,
} from "./query";

export type LofiSqliteReplicaOptions = {
  /** Base URL below which the backend serves `/_internal`. */
  baseUrl: string | URL;
  fetch: typeof globalThis.fetch;
  schemas: LofiSchemaRegistration[];
  localSchemas: LofiSchemaRegistration[];
  projections: AnyLofiLocalProjection[];
  /** Tables whose rows are skipped instead of stored. */
  ephemeralTables: LofiEphemeralTable[];
  /** Receives synchronization failures of the tab that currently writes the replica. */
  onError: (error: unknown) => void;
  /**
   * How long a tab whose synchronization stopped on an error waits before competing for the writer
   * role again. Another tab takes over meanwhile.
   */
  retryDelayMs: number;
};

export type LofiSqliteReplicaDependencies = {
  openDatabase(options: {
    databaseName: string;
  }): Promise<LofiSqliteDatabase & { close?: () => Promise<void> | void }>;
};

export type LofiSqliteReplica = {
  /** OPFS file name, derived from the backend identity and the registered schemas. */
  readonly databaseName: string;
  /** Runs SQL on this tab's connection after its pending replication writes. */
  execute: SqliteLofiAdapter["execute"];
  /** Like `execute`, but decodes each row with the query's declared columns. */
  query<TColumns extends Record<string, LofiSqliteResultColumn>>(
    query: LofiSqliteQuery<TColumns>,
  ): Promise<LofiSqliteQueryRow<TColumns>[]>;
  /** Calls `listener` after any tab applies outbox entries to this replica. */
  subscribe(listener: () => void): () => void;
  /** Stops synchronizing, hands the writer role to another tab, and closes the connection. */
  close(): Promise<void>;
};

const CHANGED_MESSAGE = "changed";

/** Names the replica's outbox cursor, `<endpoint>::outbox`, in its `lofi_meta` table. */
export const LOFI_SQLITE_ENDPOINT_NAME = "lofi-sqlite";

/**
 * Opens a SQLite replica of one Fragno backend's outbox in this tab. Every tab reads through its
 * own connection; one tab at a time, elected with a Web Lock, streams the outbox and writes.
 */
export async function openLofiSqliteReplica(
  options: LofiSqliteReplicaOptions,
  dependencies: LofiSqliteReplicaDependencies = { openDatabase: openBrowserOpfsDatabase },
): Promise<LofiSqliteReplica> {
  const urls = resolveFragnoInternalUrls(options.baseUrl);
  const { adapterIdentity } = await fetchFragnoInternalDescription({
    internalUrl: urls.internal,
    fetch: options.fetch,
  });
  const databaseName = await replicaDatabaseName({
    baseUrl: urls.baseUrl,
    adapterIdentity,
    registrations: [...options.schemas, ...options.localSchemas],
  });

  const database = await dependencies.openDatabase({ databaseName });
  let adapter: SqliteLofiAdapter;
  try {
    adapter = await SqliteLofiAdapter.open({
      database,
      schemas: options.schemas,
      localSchemas: options.localSchemas,
      projections: options.projections,
    });
  } catch (error) {
    await database.close?.();
    throw error;
  }

  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const channel = new BroadcastChannel(`fragno-lofi:${databaseName}`);
  channel.onmessage = (event: MessageEvent) => {
    if (event.data === CHANGED_MESSAGE) {
      notify();
    }
  };

  const lifetime = new AbortController();
  const lockName = `fragno-lofi:${databaseName}`;
  const writeWhileElected = async () => {
    while (!lifetime.signal.aborted) {
      await navigator.locks.request(lockName, { signal: lifetime.signal }, async () => {
        // Chrome can grant a request whose signal was already aborted.
        if (lifetime.signal.aborted) {
          return;
        }
        const term = startWriterTerm(adapter);
        // Holding the lock until close or a stopping error keeps every other tab a reader.
        await new Promise<void>((resolve) => {
          void whenAborted(lifetime.signal).then(resolve);
          new LofiClient({
            outboxUrl: urls.outbox.toString(),
            outboxStreamUrl: urls.outboxStream.toString(),
            outboxTransport: "stream",
            endpointName: LOFI_SQLITE_ENDPOINT_NAME,
            adapter: term.adapter,
            fetch: options.fetch,
            ephemeralTables: options.ephemeralTables,
            onSyncApplied: (result) => {
              if (result.appliedDurableMutations === 0) {
                return;
              }
              notify();
              channel.postMessage(CHANGED_MESSAGE);
            },
            onError: options.onError,
            onStopped: () => {
              resolve();
            },
          }).start({ signal: lifetime.signal });
        });
        await term.end();
      });
      // The lock is released, so another tab can take over before this one competes again.
      await sleep(options.retryDelayMs, lifetime.signal);
    }
  };
  const writing = writeWhileElected().catch((error: unknown) => {
    if (!lifetime.signal.aborted) {
      options.onError(error);
    }
  });

  return {
    databaseName,
    execute: (sql, params) => adapter.execute(sql, params),
    async query(query) {
      return decodeLofiSqliteQueryRows(query, await adapter.execute(query.sql, query.params));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      lifetime.abort();
      channel.close();
      await writing;
      // Lets this tab's pending reads finish before the connection goes away.
      await adapter.execute("SELECT 1");
      await database.close?.();
    },
  };
}

/**
 * A changed backend, layout, or schema opens a fresh database that replays the outbox, so
 * replicas never migrate. 32 hex characters keep the name under the 56-character OPFS limit
 * observed in some Chromium runtimes.
 */
async function replicaDatabaseName(options: {
  baseUrl: string;
  adapterIdentity: string;
  registrations: LofiSchemaRegistration[];
}): Promise<string> {
  const schemas = options.registrations
    .map((registration) => ({
      name: registeredSchemaName(registration),
      version: registration.schema.version,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const key = JSON.stringify({
    baseUrl: options.baseUrl,
    adapterIdentity: options.adapterIdentity,
    layoutVersion: LOFI_SQLITE_LAYOUT_VERSION,
    schemas,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  return `fragno-lofi-${hash}.sqlite`;
}

/**
 * Fences one tab's time as the writer. A stopped `LofiClient` can still be finishing an entry, so
 * the lock is released only after the term's writes settle, and calls after the term ends are
 * refused, which the client treats as cancellation.
 */
function startWriterTerm(adapter: SqliteLofiAdapter): {
  adapter: LofiAdapter;
  end(): Promise<void>;
} {
  const pending = new Set<Promise<unknown>>();
  let ended = false;
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (ended) {
      return Promise.reject(new DOMException("The tab is no longer the writer.", "AbortError"));
    }
    const result = operation();
    pending.add(result);
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result),
    );
    return result;
  };
  return {
    adapter: {
      applyOutboxEntry: (entry) => run(() => adapter.applyOutboxEntry(entry)),
      getMeta: (key) => run(() => adapter.getMeta(key)),
      setMeta: (key, value) => run(() => adapter.setMeta(key, value)),
    },
    async end() {
      ended = true;
      await Promise.allSettled(pending);
    },
  };
}

function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return Promise.race([
    whenAborted(signal),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      void whenAborted(signal).then(() => {
        clearTimeout(timer);
      });
    }),
  ]);
}

async function openBrowserOpfsDatabase(options: { databaseName: string }) {
  const { openBrowserWASQLiteOPFSDatabase } =
    await import("@tanstack/browser-db-sqlite-persistence");
  return await openBrowserWASQLiteOPFSDatabase({ databaseName: options.databaseName });
}
