import type { LofiSqliteReplicaOptions } from "@fragno-dev/lofi/sqlite";

/**
 * The backend a replica worker replicates: where it serves its outbox, and the identity the page
 * last saw it report. A worker starts with no arguments but its name, so the page names it with
 * this, and tabs share the worker's replica only with tabs that expect the same backend.
 */
export type WorkerReplicaTarget = { baseUrl: string; adapterIdentity: string };

/**
 * How a replica opened beside the page's own synchronizes where the browser opens few connections
 * per origin: two catch up at a time, and each polls every two seconds once caught up, so they
 * leave the connections to the page's own replica and its navigation.
 */
const BESIDE_PAGE_POLLING = { catchUpTurns: 2, intervalMs: 2_000 };

/** A worker's name: its backend, and whether its replica polls once caught up. */
export function workerReplicaName(
  target: WorkerReplicaTarget,
  options: { pollsOnceCaughtUp: boolean },
): string {
  return JSON.stringify([target.baseUrl, target.adapterIdentity, options.pollsOnceCaughtUp]);
}

/**
 * The backend a replica worker replicates, read from the name `workerReplicaName` gave it, with how
 * its replica synchronizes once caught up: streaming, without `pollOnceCaughtUp`, or polling.
 */
export function readWorkerReplicaName(
  name: string,
): WorkerReplicaTarget & Pick<LofiSqliteReplicaOptions, "pollOnceCaughtUp"> {
  const parts: unknown = JSON.parse(name);
  if (
    !Array.isArray(parts) ||
    parts.length !== 3 ||
    typeof parts[0] !== "string" ||
    typeof parts[1] !== "string" ||
    typeof parts[2] !== "boolean"
  ) {
    throw new Error(`A replica worker's name must name its backend, not ${name}.`);
  }
  const [baseUrl, adapterIdentity, pollsOnceCaughtUp] = parts as [string, string, boolean];
  return pollsOnceCaughtUp
    ? { baseUrl, adapterIdentity, pollOnceCaughtUp: BESIDE_PAGE_POLLING }
    : { baseUrl, adapterIdentity };
}
