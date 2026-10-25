/**
 * The backend a replica worker replicates: where it serves its outbox, and the identity the page
 * last saw it report. A worker starts with no arguments but its name, so the page names it with
 * this, and tabs share the worker's replica only with tabs that expect the same backend.
 */
export type WorkerReplicaTarget = { baseUrl: string; adapterIdentity: string };

export function workerReplicaName(target: WorkerReplicaTarget): string {
  return JSON.stringify([target.baseUrl, target.adapterIdentity]);
}

/** The backend a replica worker replicates, read from the name `workerReplicaName` gave it. */
export function readWorkerReplicaName(name: string): WorkerReplicaTarget {
  const target: unknown = JSON.parse(name);
  if (
    !Array.isArray(target) ||
    target.length !== 2 ||
    !target.every((part) => typeof part === "string")
  ) {
    throw new Error(`A replica worker's name must name its backend, not ${name}.`);
  }
  const [baseUrl, adapterIdentity] = target as [string, string];
  return { baseUrl, adapterIdentity };
}
