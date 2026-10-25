import { connectLofiSqlite, type LofiSqliteClient } from "@fragno-dev/lofi/sqlite";

import type { LofiSchemaRegistration } from "@fragno-dev/lofi";

const workerReplicas = new Map<string, Promise<LofiSqliteClient>>();

/**
 * This tab's connection to the SQLite replica of the backend below `baseUrl`, opened once per
 * `resourceKey`, which names the backend instance, so a changed backend opens a new replica. The
 * replica lives in the worker `startWorker` starts, which serves it with `serveLofiSqliteWorker`.
 */
export function getWorkerReplica(options: {
  baseUrl: string;
  resourceKey: string;
  schemas: LofiSchemaRegistration[];
  startWorker(baseUrl: string): Worker;
}): Promise<LofiSqliteClient> {
  const key = JSON.stringify([options.baseUrl, options.resourceKey]);
  const existing = workerReplicas.get(key);
  if (existing) {
    return existing;
  }
  // A failed open stays cached: Suspense needs the same promise on every render, and the error
  // boundary offers the reload.
  const replica = connectLofiSqlite({
    port: options.startWorker(options.baseUrl),
    schemas: options.schemas,
  });
  workerReplicas.set(key, replica);
  return replica;
}
