import { randomUUID } from "node:crypto";

import {
  readNodeRuntimeEpochMilliseconds,
  type NodeRuntimeClock,
} from "../runtime/node-runtime-clock";
import type { GraftControlStore, GraftObjectLocation } from "./graft-control-store";
import type { GraftDatabaseOperations } from "./graft-database-operations";
import { createGraftObjectAuthoritySchema } from "./graft-object-authority";
import type { GraftNodeRuntimeStorage } from "./graft-runtime-storage";
import { initializeGraftSqlite, openNewGraftDatabase } from "./graft-sqlite";

/** Selects whether a missing object is created on first operation or rejected. */
export type GraftObjectProvisioningPolicy = { kind: "preprovisioned" } | { kind: "lazy" };

/** Reports how one canonical object database location was obtained. */
export type GraftProvisionObjectResult =
  | {
      outcome: "already-registered";
      location: GraftObjectLocation;
    }
  | {
      outcome: "registered-candidate";
      location: GraftObjectLocation;
    }
  | {
      outcome: "used-concurrent-winner";
      location: GraftObjectLocation;
      unusedCandidateRemoteLogId: string;
    };

type GraftObjectDatabaseCandidate = GraftObjectLocation;

/** Creates an object candidate and lets the durable control command select its canonical log. */
export function provisionGraftObject(options: {
  objectId: string;
  storage: GraftNodeRuntimeStorage;
  controlStore: Pick<GraftControlStore, "readObjectLocation" | "registerObjectDatabase">;
  clock: NodeRuntimeClock;
  databaseOperations: GraftDatabaseOperations;
}): GraftProvisionObjectResult {
  const existing = options.controlStore.readObjectLocation(options.objectId);
  if (existing) {
    return { outcome: "already-registered", location: existing };
  }

  const candidate = createGraftObjectDatabaseCandidate({
    objectId: options.objectId,
    configPath: options.storage.configPath,
    databaseOperations: options.databaseOperations,
  });
  const commandCreatedAtMs = readNodeRuntimeEpochMilliseconds(options.clock);
  const registration = options.controlStore.registerObjectDatabase({
    commandId: randomUUID(),
    commandCreatedAtMs,
    input: candidate,
  });
  const location = {
    objectId: registration.ownership.objectId,
    remoteLogId: registration.ownership.remoteLogId,
  };
  if (registration.outcome === "registered") {
    return { outcome: "registered-candidate", location };
  }
  return {
    outcome: "used-concurrent-winner",
    location,
    unusedCandidateRemoteLogId: candidate.remoteLogId,
  };
}

function createGraftObjectDatabaseCandidate(options: {
  objectId: string;
  configPath: string;
  databaseOperations: GraftDatabaseOperations;
}): GraftObjectDatabaseCandidate {
  initializeGraftSqlite(options.configPath);
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
        generation INTEGER NOT NULL,
        installation_id TEXT NOT NULL UNIQUE
      ) STRICT;
    `);
    database
      .prepare("INSERT INTO node_runtime_object_identity (singleton, object_id) VALUES (1, ?)")
      .run(options.objectId);
    createGraftObjectAuthoritySchema(database, options.objectId);
    options.databaseOperations.push(database);
    return {
      objectId: options.objectId,
      remoteLogId: options.databaseOperations.readRemoteLogId(database),
    };
  } finally {
    database.close();
  }
}
