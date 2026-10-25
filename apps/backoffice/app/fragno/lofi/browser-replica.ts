import {
  openLofiSqliteReplica,
  type LofiSqliteReplica,
  type LofiSqliteReplicaOptions,
} from "@fragno-dev/lofi/sqlite";

import { backofficeFetch } from "@/fragno/auth/browser-auth.client";

/** A reading tab that lost the writer to an error competes for it again after this long. */
const RETRY_DELAY_MS = 5_000;

const replicas = new Map<string, Promise<LofiSqliteReplica>>();

/**
 * This tab's SQLite replica of the backend below `baseUrl`, opened once per `resourceKey`, which
 * names the backend instance, so a changed backend opens a new replica.
 */
export function getBrowserReplica(
  options: {
    name: string;
    baseUrl: string;
    resourceKey: string;
  } & Pick<LofiSqliteReplicaOptions, "schemas"> &
    Partial<Pick<LofiSqliteReplicaOptions, "localSchemas" | "projections" | "ephemeralTables">>,
): Promise<LofiSqliteReplica> {
  const key = JSON.stringify([options.baseUrl, options.resourceKey]);
  const existing = replicas.get(key);
  if (existing) {
    return existing;
  }
  // A failed open stays cached: Suspense needs the same promise on every render, and the error
  // boundary offers the reload.
  const replica = openLofiSqliteReplica({
    baseUrl: options.baseUrl,
    fetch: backofficeFetch,
    schemas: options.schemas,
    localSchemas: options.localSchemas ?? [],
    projections: options.projections ?? [],
    ephemeralTables: options.ephemeralTables ?? [],
    onError(error) {
      console.error(`The ${options.name} replica failed to synchronize.`, error);
    },
    retryDelayMs: RETRY_DELAY_MS,
  });
  replicas.set(key, replica);
  return replica;
}
