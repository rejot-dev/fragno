import { connectLofiSqlite, type LofiSqliteClient } from "@fragno-dev/lofi/sqlite";

import type { LofiSchemaRegistration } from "@fragno-dev/lofi";

import { workerReplicaName, type WorkerReplicaTarget } from "./worker-replica-target";

const workerReplicas = new Map<string, Promise<LofiSqliteClient>>();

/**
 * This tab's connection to the SQLite replica of `target`, opened once per backend instance, so a
 * replaced backend opens a new replica. The replica lives in the worker `startWorker` starts with
 * `name`, which serves it with `serveLofiSqliteWorker` and reads its backend with
 * `readWorkerReplicaName`.
 */
export function getWorkerReplica(options: {
  target: WorkerReplicaTarget;
  schemas: LofiSchemaRegistration[];
  startWorker(name: string): Worker;
}): Promise<LofiSqliteClient> {
  const name = workerReplicaName(options.target);
  const existing = workerReplicas.get(name);
  if (existing) {
    return existing;
  }
  // It rejects only for a backend replaced since the page loaded, and stays cached: Suspense needs
  // the same promise on every render, and the error boundary offers the reload.
  const replica = connectLofiSqlite({
    port: options.startWorker(name),
    schemas: options.schemas,
  });
  workerReplicas.set(name, replica);
  return replica;
}
