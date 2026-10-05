import type { DatabaseSync } from "node:sqlite";

import {
  createSqlitePragmaGraftDatabaseOperations,
  type GraftDatabaseOperations,
} from "@fragno-private/backoffice-node-runtime/graft-database-operations";
import type { createManualNodeRuntimeClock } from "@fragno-private/backoffice-node-runtime/node-runtime-clock";

/** Measures real control I/O and injects storage failures or elapsed read time at its boundary. */
export class ControlScenarioGraftOperations implements GraftDatabaseOperations {
  readonly counts = { clones: 0, pulls: 0, pushes: 0 };
  readonly connections: DatabaseSync[] = [];
  pullFailure: "none" | "before-pull" | "after-pull" = "none";
  pushFailure: "none" | "before-push" | "lose-response" = "none";
  pullElapsedMs = 0;
  readonly #operations = createSqlitePragmaGraftDatabaseOperations();
  readonly #clock: ReturnType<typeof createManualNodeRuntimeClock>;

  constructor(clock: ReturnType<typeof createManualNodeRuntimeClock>) {
    this.#clock = clock;
  }

  clone(database: DatabaseSync, remoteLogId: string): void {
    this.counts.clones += 1;
    this.connections.push(database);
    this.#operations.clone(database, remoteLogId);
  }

  pull(database: DatabaseSync): void {
    this.counts.pulls += 1;
    if (this.pullFailure === "before-pull") {
      throw new Error("EXPECTED_CONTROL_PULL_FAILURE_BEFORE_REFRESH");
    }
    this.#operations.pull(database);
    this.#clock.advanceBy(this.pullElapsedMs);
    if (this.pullFailure === "after-pull") {
      throw new Error("EXPECTED_CONTROL_PULL_FAILURE_AFTER_REFRESH");
    }
  }

  push(database: DatabaseSync): void {
    this.counts.pushes += 1;
    if (this.pushFailure === "before-push") {
      throw new Error("EXPECTED_CONTROL_PUSH_FAILURE_BEFORE_COMMIT");
    }
    this.#operations.push(database);
    if (this.pushFailure === "lose-response") {
      this.pushFailure = "none";
      throw new Error("EXPECTED_CONTROL_PUSH_RESPONSE_LOST");
    }
  }

  readRemoteLogId(database: DatabaseSync): string {
    return this.#operations.readRemoteLogId(database);
  }
}
