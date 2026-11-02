import { connectLofiSqlite, type LofiSqliteClient } from "@fragno-dev/lofi/sqlite";

import type { LofiSchemaRegistration } from "@fragno-dev/lofi";

import { workerReplicaName, type WorkerReplicaTarget } from "./worker-replica-target";

// A replica nothing holds closes this long after, so a view that closes and opens again, as React
// does in development and as navigating back and forth does, keeps its worker.
const RELEASE_DELAY_MS = 10_000;
// A worker that does not confirm closing in time is terminated anyway, holding its lead or not.
const CLOSE_TIMEOUT_MS = 5_000;

type WorkerReplicaOptions = {
  target: WorkerReplicaTarget;
  schemas: LofiSchemaRegistration[];
  /** Starts the worker with the name `readWorkerReplicaName` reads. */
  startWorker(name: string): Worker;
};

type WorkerReplica = {
  replica: Promise<LofiSqliteClient>;
  worker: Worker;
  /** Kept open for the life of the tab, as the replicas suspending views read are. */
  pinned: boolean;
  holders: number;
  closing: ReturnType<typeof setTimeout> | null;
};

const workerReplicas = new Map<string, WorkerReplica>();

/**
 * Whether the page came over HTTP/1.1, where the browser opens only six connections per origin and
 * every outbox stream holds one. HTTP/2 and HTTP/3 carry every request over one connection.
 */
function connectionsAreScarce(): boolean {
  const [navigation] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
  return navigation?.nextHopProtocol === "http/1.1";
}

/**
 * The tab's replica of `options.target`, opened if it has none. A replica the tab only holds polls
 * once caught up where connections are scarce; one the tab pins later keeps the worker it has.
 */
function openWorkerReplica(options: WorkerReplicaOptions, pins: boolean): WorkerReplica {
  const key = backendKey(options.target);
  const existing = workerReplicas.get(key);
  if (existing) {
    if (existing.closing !== null) {
      clearTimeout(existing.closing);
      existing.closing = null;
    }
    return existing;
  }
  const worker = options.startWorker(
    workerReplicaName(options.target, { pollsOnceCaughtUp: !pins && connectionsAreScarce() }),
  );
  // It rejects only for a backend replaced since the page loaded, and stays cached: Suspense needs
  // the same promise on every render, and the error boundary offers the reload.
  const opened: WorkerReplica = {
    replica: connectLofiSqlite({ port: worker, schemas: options.schemas }),
    worker,
    pinned: false,
    holders: 0,
    closing: null,
  };
  workerReplicas.set(key, opened);
  return opened;
}

function backendKey(target: WorkerReplicaTarget): string {
  return JSON.stringify([target.baseUrl, target.adapterIdentity]);
}

/** Closes the replica's worker, which hands its lead to another tab first if it has it. */
async function closeWorkerReplica(key: string, opened: WorkerReplica): Promise<void> {
  workerReplicas.delete(key);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      opened.replica.then((client) => client.close()),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // A replica that never opened has nothing to close.
  } finally {
    clearTimeout(timeout);
    opened.worker.terminate();
  }
}

/**
 * This tab's connection to the SQLite replica of `target`, opened once per backend instance, so a
 * replaced backend opens a new replica, and kept open for the life of the tab. The replica lives in
 * the worker `startWorker` starts with `name`, which serves it with `serveLofiSqliteWorker` and
 * reads its backend with `readWorkerReplicaName`.
 */
export function getWorkerReplica(options: WorkerReplicaOptions): Promise<LofiSqliteClient> {
  const opened = openWorkerReplica(options, true);
  opened.pinned = true;
  return opened.replica;
}

/**
 * Like `getWorkerReplica`, but held until `release`: once nothing holds it and the tab does not
 * keep it open, the replica's worker closes, and with it the replica's stream. Where connections
 * are scarce, a replica the tab only holds takes turns to catch up and polls from then on.
 */
export function retainWorkerReplica(options: WorkerReplicaOptions): {
  replica: Promise<LofiSqliteClient>;
  release(): void;
} {
  const key = backendKey(options.target);
  const opened = openWorkerReplica(options, false);
  opened.holders += 1;
  let released = false;
  return {
    replica: opened.replica,
    release() {
      if (released) {
        return;
      }
      released = true;
      opened.holders -= 1;
      if (opened.holders === 0 && !opened.pinned) {
        opened.closing = setTimeout(() => {
          void closeWorkerReplica(key, opened);
        }, RELEASE_DELAY_MS);
      }
    },
  };
}
