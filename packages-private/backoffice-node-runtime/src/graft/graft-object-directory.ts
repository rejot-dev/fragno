import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { createSqlitePragmaGraftDatabaseOperations } from "./graft-database-operations";
import {
  initializeGraftSqlite,
  openClonedGraftDatabase,
  openNewGraftDatabase,
} from "./graft-sqlite";

const GRAFT_CONTROL_FORMAT = 1;
const graftOperations = createSqlitePragmaGraftDatabaseOperations();

/** Identifies one process-local Graft cache and the durable fleet directory log it clones. */
export type GraftNodeRuntimeStorage = {
  configPath: string;
  controlRemoteLogId: string;
};

/** Creates the fleet's control database and returns the remote log ID to retain in configuration. */
export function provisionGraftControlDatabase(configPath: string): string {
  initializeGraftSqlite(configPath);
  const database = openNewGraftDatabase(`control-provision-${randomUUID()}`);
  try {
    database.exec(`
      CREATE TABLE node_runtime_control_format (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        format INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE node_runtime_object_directory (
        object_id TEXT PRIMARY KEY,
        remote_log_id TEXT NOT NULL UNIQUE
      ) STRICT;
    `);
    database
      .prepare("INSERT INTO node_runtime_control_format (singleton, format) VALUES (1, ?)")
      .run(GRAFT_CONTROL_FORMAT);
    graftOperations.push(database);
    return graftOperations.readRemoteLogId(database);
  } finally {
    database.close();
  }
}

/** Resolves stable object identities to one Graft remote log; this slice assumes one runtime owner. */
export class GraftObjectDirectory {
  readonly #database: DatabaseSync;
  #failure: Error | null = null;

  constructor(storage: GraftNodeRuntimeStorage) {
    initializeGraftSqlite(storage.configPath);
    this.#database = openClonedGraftDatabase(
      `control-clone-${randomUUID()}`,
      storage.controlRemoteLogId,
      graftOperations,
    );
    const format = this.#database
      .prepare("SELECT format FROM node_runtime_control_format WHERE singleton = 1")
      .get() as { format: number } | undefined;
    if (format?.format !== GRAFT_CONTROL_FORMAT) {
      this.#database.close();
      throw new Error(`GRAFT_CONTROL_FORMAT_UNSUPPORTED:${String(format?.format)}`);
    }
  }

  objectIds(): string[] {
    this.#requireUsable();
    return (
      this.#database
        .prepare("SELECT object_id FROM node_runtime_object_directory ORDER BY object_id")
        .all() as { object_id: string }[]
    ).map((row) => row.object_id);
  }

  resolveObjectRemoteLogId(objectId: string): string {
    this.#requireUsable();
    const existing = this.#database
      .prepare("SELECT remote_log_id FROM node_runtime_object_directory WHERE object_id = ?")
      .get(objectId) as { remote_log_id: string } | undefined;
    if (existing) {
      return existing.remote_log_id;
    }

    const remoteLogId = provisionGraftObjectDatabase(objectId);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          "INSERT INTO node_runtime_object_directory (object_id, remote_log_id) VALUES (?, ?)",
        )
        .run(objectId, remoteLogId);
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.isTransaction) {
        this.#database.exec("ROLLBACK");
      }
      throw error;
    }
    try {
      graftOperations.push(this.#database);
    } catch (cause) {
      this.#failure = new Error("GRAFT_CONTROL_DIRECTORY_DURABILITY_UNCERTAIN", { cause });
      throw this.#failure;
    }
    return remoteLogId;
  }

  close(): void {
    this.#database.close();
  }

  #requireUsable(): void {
    if (this.#failure) {
      throw new Error("GRAFT_CONTROL_DIRECTORY_POISONED", { cause: this.#failure });
    }
  }
}

function provisionGraftObjectDatabase(objectId: string): string {
  const database = openNewGraftDatabase(`object-provision-${randomUUID()}`);
  try {
    database.exec(`
      CREATE TABLE node_runtime_object_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        object_id TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE node_runtime_values (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      ) STRICT;
      CREATE TABLE node_runtime_alarm (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        timestamp INTEGER NOT NULL,
        generation INTEGER NOT NULL
      ) STRICT;
    `);
    database
      .prepare("INSERT INTO node_runtime_object_identity (singleton, object_id) VALUES (1, ?)")
      .run(objectId);
    graftOperations.push(database);
    return graftOperations.readRemoteLogId(database);
  } finally {
    database.close();
  }
}
