import {
  openLofiSqliteReplicaOn,
  type LofiSqliteReplica,
  type LofiSqliteReplicaDependencies,
  type LofiSqliteReplicaOptions,
} from "./replica";

/**
 * Opens a SQLite replica of one Fragno backend's outbox in this tab, by default in OPFS through
 * TanStack DB's wa-sqlite worker. Every tab reads through its own connection; one tab at a time,
 * elected with a Web Lock, streams the outbox and writes. Kept apart from the replica itself, so
 * replica workers, which open their own database, do not bundle that worker.
 */
export function openLofiSqliteReplica(
  options: LofiSqliteReplicaOptions,
  dependencies: LofiSqliteReplicaDependencies = { openDatabase: openBrowserOpfsDatabase },
): Promise<LofiSqliteReplica> {
  return openLofiSqliteReplicaOn(options, dependencies);
}

/** Opens after failing this many times, waiting `OPEN_RETRY_DELAY_MS` times the attempt between. */
const OPEN_ATTEMPTS = 3;
const OPEN_RETRY_DELAY_MS = 50;

/**
 * Every database worker starting in this origin deletes the temporary directories that closed
 * workers left behind, and two starting at once can both try to delete the same one. The second
 * fails its open with "A requested file or directory could not be found", so the open is retried.
 * The worker reports that as an `OPFSWorkerRequestError`, unlike a missing OPFS or a bad
 * configuration, which are not retried.
 */
async function openBrowserOpfsDatabase(options: { databaseName: string }) {
  const { openBrowserWASQLiteOPFSDatabase } =
    await import("@tanstack/browser-db-sqlite-persistence");
  for (let attempt = 1; ; attempt++) {
    try {
      return await openBrowserWASQLiteOPFSDatabase({ databaseName: options.databaseName });
    } catch (error) {
      if (
        attempt === OPEN_ATTEMPTS ||
        !(error instanceof Error) ||
        error.name !== "OPFSWorkerRequestError"
      ) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, OPEN_RETRY_DELAY_MS * attempt);
      });
    }
  }
}
