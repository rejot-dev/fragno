import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { requireGraftControlFormat } from "./graft-control-schema";
import { runWithGraftControlStoreLock } from "./graft-control-store-lock";
import type { GraftDatabaseOperations } from "./graft-database-operations";
import type { GraftNodeRuntimeStorage } from "./graft-runtime-storage";
import { openClonedGraftDatabase } from "./graft-sqlite";

/** Owns a clean control replica; snapshot callbacks must finish synchronously without retaining it. */
export class GraftControlReadReplica {
  readonly #storage: GraftNodeRuntimeStorage;
  readonly #operations: GraftDatabaseOperations;
  #database: DatabaseSync | null = null;
  #closed = false;

  constructor(storage: GraftNodeRuntimeStorage, operations: GraftDatabaseOperations) {
    this.#storage = storage;
    this.#operations = operations;
  }

  readSnapshot<TResult>(read: (database: DatabaseSync) => TResult): TResult {
    return runWithGraftControlStoreLock(() => {
      if (this.#closed) {
        throw new Error("GRAFT_CONTROL_STORE_CLOSED");
      }
      try {
        if (this.#database === null) {
          this.#database = openClonedGraftDatabase(
            `control-read-${randomUUID()}`,
            this.#storage.controlRemoteLogId,
            this.#operations,
          );
          // Speculative command state must never enter a reusable read snapshot.
          this.#database.exec("PRAGMA query_only = ON");
        } else {
          this.#operations.pull(this.#database);
        }
        requireGraftControlFormat(this.#database);
        return read(this.#database);
      } catch (error) {
        // A failed refresh or query cannot leave a usable stale snapshot behind.
        this.#discardDatabase();
        throw error;
      }
    });
  }

  close(): void {
    this.#closed = true;
    this.#discardDatabase();
  }

  #discardDatabase(): void {
    const database = this.#database;
    this.#database = null;
    database?.close();
  }
}
