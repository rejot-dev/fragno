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
import { registrationsNamingReplica } from "./rebuild";

export type LofiSqliteReplicaOptions = {
  /** Base URL below which the backend serves `/_internal`. */
  baseUrl: string | URL;
  /**
   * The identity of the backend the page expects, as `GET /_internal` reported it, if the page
   * knows it. Tabs share a leader only with tabs that expect the same backend, and the replica
   * refuses to open on a backend that reports another, such as one replaced since the page loaded.
   */
  adapterIdentity?: string;
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
  /** Runs `read` in a read transaction on this tab's connection, after its pending replication writes. */
  read: SqliteLofiAdapter["read"];
  /** Calls `listener` after any tab applies outbox entries to this replica. */
  subscribe(listener: (change: LofiSqliteReplicaChange) => void): () => void;
  /**
   * How far this replica has caught up with its backend, as this tab knows it. This and
   * `subscribeStatus` need no `this`, so they can go to React's `useSyncExternalStore` directly.
   */
  getStatus: () => LofiSqliteReplicaStatus;
  /** Calls `listener` whenever `getStatus()` returns a new status. */
  subscribeStatus: (listener: () => void) => () => void;
  /** Stops synchronizing, hands the writer role to another tab, and closes the connection. */
  close(): Promise<void>;
};

/**
 * A replica is `catching-up` until it first holds every entry that existed when a stream started,
 * and `caught-up` from then on, through reconnects, writer changes, and later sessions: its data is
 * then a complete, if possibly older, state of the backend. `fraction` estimates
 * the share replayed, and is null until the server says how many entries there are. `error` is the
 * message of the last synchronization failure, cleared when synchronization next makes progress;
 * the writing tab retries on its own.
 */
export type LofiSqliteReplicaStatus =
  | { phase: "catching-up"; fraction: number | null; error: string | null }
  | { phase: "caught-up"; error: string | null };

/**
 * What applying outbox entries changed: the tables it wrote, by SQL name, as `lofiSqliteTableName`
 * names them, or null when the tab that wrote does not say.
 */
export type LofiSqliteReplicaChange = { tables: readonly string[] | null };

/** What tabs tell each other. Only the writing tab answers a status request. */
type ReplicaMessage =
  // Tabs running an older lofi send no tables.
  | { type: "changed"; tables?: readonly string[] }
  | { type: "status"; status: LofiSqliteReplicaStatus }
  | { type: "status-request" };

/**
 * The backend reports another identity than the page expects. Unlike a failed request, this does
 * not pass: only a page loaded since can replicate the new backend.
 */
export class LofiSqliteBackendReplacedError extends Error {}

/** Names the replica's outbox cursor, `<endpoint>::outbox`, in its `lofi_meta` table. */
export const LOFI_SQLITE_ENDPOINT_NAME = "lofi-sqlite";

/** Set in `lofi_meta` once the replica has caught up, so later sessions open `caught-up`. */
const CAUGHT_UP_META_KEY = `caught-up:${LOFI_SQLITE_ENDPOINT_NAME}`;

/**
 * Opens a SQLite replica of one Fragno backend's outbox in this tab, on the database
 * `dependencies` opens. Every tab reads through its own connection; one tab at a time, elected
 * with a Web Lock, streams the outbox and writes. `openLofiSqliteReplica` opens it in OPFS.
 */
export async function openLofiSqliteReplicaOn(
  options: LofiSqliteReplicaOptions,
  dependencies: LofiSqliteReplicaDependencies,
): Promise<LofiSqliteReplica> {
  const urls = resolveFragnoInternalUrls(options.baseUrl);
  const { adapterIdentity } = await fetchFragnoInternalDescription({
    internalUrl: urls.internal,
    fetch: options.fetch,
  });
  if (options.adapterIdentity !== undefined && options.adapterIdentity !== adapterIdentity) {
    throw new LofiSqliteBackendReplacedError(
      `The backend at ${urls.baseUrl} was replaced since the page loaded: it is now "${adapterIdentity}", not "${options.adapterIdentity}". Reload the page to replicate it.`,
    );
  }
  const databaseName = await replicaDatabaseName({
    baseUrl: urls.baseUrl,
    adapterIdentity,
    registrations: registrationsNamingReplica(options),
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

  const listeners = new Set<(change: LofiSqliteReplicaChange) => void>();
  const notify = (change: LofiSqliteReplicaChange) => {
    for (const listener of listeners) {
      listener(change);
    }
  };
  const channel = new BroadcastChannel(`fragno-lofi:${databaseName}`);
  const post = (message: ReplicaMessage) => {
    channel.postMessage(message);
  };

  let status: LofiSqliteReplicaStatus =
    (await adapter.getMeta(CAUGHT_UP_META_KEY)) === undefined
      ? { phase: "catching-up", fraction: null, error: null }
      : { phase: "caught-up", error: null };
  let writing = false;
  const statusListeners = new Set<() => void>();
  const updateStatus = (next: LofiSqliteReplicaStatus) => {
    // Data a tab has shown does not disappear because a later stream catches up again.
    const merged: LofiSqliteReplicaStatus =
      status.phase === "caught-up" ? { phase: "caught-up", error: next.error } : next;
    if (JSON.stringify(merged) === JSON.stringify(status)) {
      return;
    }
    status = merged;
    for (const listener of statusListeners) {
      listener();
    }
  };
  const report = (next: LofiSqliteReplicaStatus) => {
    updateStatus(next);
    post({ type: "status", status: next });
  };

  channel.onmessage = (event: MessageEvent<ReplicaMessage>) => {
    const message = event.data;
    if (message.type === "changed") {
      notify({ tables: message.tables ?? null });
    } else if (message.type === "status") {
      updateStatus(message.status);
    } else if (writing) {
      post({ type: "status", status });
    }
  };
  post({ type: "status-request" });
  const reportError = (error: unknown) => {
    report({ ...status, error: error instanceof Error ? error.message : String(error) });
    options.onError(error);
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
        writing = true;
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
              if (status.error !== null) {
                report({ ...status, error: null });
              }
              // A rebuild changes tables even in a batch whose entries were applied before.
              const tables = adapter.takeChangedTables();
              if (result.appliedDurableMutations === 0 && tables.length === 0) {
                return;
              }
              notify({ tables });
              post({ type: "changed", tables });
            },
            onCatchUp: (progress) => {
              if (progress.status === "caught-up" && status.phase === "catching-up") {
                // Failing to remember only shows the next session's download again.
                void term.adapter.setMeta(CAUGHT_UP_META_KEY, "true").catch(() => {});
              }
              report(
                progress.status === "caught-up"
                  ? { phase: "caught-up", error: null }
                  : { phase: "catching-up", fraction: progress.fraction, error: null },
              );
            },
            onError: reportError,
            onStopped: () => {
              resolve();
            },
          }).start({ signal: lifetime.signal });
        });
        writing = false;
        await term.end();
      });
      // The lock is released, so another tab can take over before this one competes again.
      await sleep(options.retryDelayMs, lifetime.signal);
    }
  };
  const writer = writeWhileElected().catch((error: unknown) => {
    if (!lifetime.signal.aborted) {
      reportError(error);
    }
  });

  return {
    databaseName,
    execute: (sql, params) => adapter.execute(sql, params),
    async query(query) {
      return decodeLofiSqliteQueryRows(query, await adapter.execute(query.sql, query.params));
    },
    read: (read) => adapter.read(read),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getStatus: () => status,
    subscribeStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    async close() {
      lifetime.abort();
      channel.close();
      await writer;
      // Lets this tab's pending reads finish before the connection goes away.
      await adapter.execute("SELECT 1");
      await database.close?.();
    },
  };
}

/**
 * A changed backend, layout, or schema opens a fresh database that replays the outbox, so
 * replicas never migrate. Local schemas that only rebuildable projections write are left out:
 * the replica rebuilds those from its rows. 32 hex characters keep the name under the 56-character OPFS limit
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
      // Writes refused mid-batch roll the batch back; the next writer resumes from its start.
      applyOutboxBatch: (apply) =>
        run(() =>
          adapter.applyOutboxBatch((writer) =>
            apply({
              applyOutboxEntry: (entry) => run(() => writer.applyOutboxEntry(entry)),
              setMeta: (key, value) => run(() => writer.setMeta(key, value)),
            }),
          ),
        ),
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
