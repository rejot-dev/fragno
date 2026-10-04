import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { createGraftControlSchema, requireGraftControlFormat } from "./graft-control-schema";
import { createSqlitePragmaGraftDatabaseOperations } from "./graft-database-operations";
import {
  initializeGraftSqlite,
  openClonedGraftDatabase,
  openNewGraftDatabase,
} from "./graft-sqlite";

const graftControlDatabaseOperations = createSqlitePragmaGraftDatabaseOperations();

/** Journals the canonical log before any remote push; recovery always reuses that log. */
export async function provisionJournaledGraftControlDatabase(
  configPath: string,
  reservedRemoteLogId: string | null,
  reserveRemoteLogId: (remoteLogId: string) => Promise<void>,
): Promise<string> {
  initializeGraftSqlite(configPath);
  const tag = `control-bootstrap-${randomUUID()}`;
  const database =
    reservedRemoteLogId === null
      ? openNewGraftDatabase(tag)
      : openClonedGraftDatabase(tag, reservedRemoteLogId, graftControlDatabaseOperations);
  try {
    const remoteLogId = graftControlDatabaseOperations.readRemoteLogId(database);
    if (reservedRemoteLogId === null) {
      await reserveRemoteLogId(remoteLogId);
    }
    ensurePublishedGraftControlDatabase(configPath, remoteLogId, database);
    return remoteLogId;
  } finally {
    database.close();
  }
}

/** Reserves a Graft control log identity without publishing remote history. */
export function reserveGraftControlDatabase(configPath: string): string {
  initializeGraftSqlite(configPath);
  const database = openNewGraftDatabase(`control-reserve-${randomUUID()}`);
  try {
    return graftControlDatabaseOperations.readRemoteLogId(database);
  } finally {
    database.close();
  }
}

/** Publishes or verifies the control schema for a previously reserved Graft log identity. */
export function publishGraftControlDatabase(configPath: string, remoteLogId: string): string {
  initializeGraftSqlite(configPath);
  const database = openClonedGraftDatabase(
    `control-publish-${randomUUID()}`,
    remoteLogId,
    graftControlDatabaseOperations,
  );
  try {
    ensurePublishedGraftControlDatabase(configPath, remoteLogId, database);
    return remoteLogId;
  } finally {
    database.close();
  }
}

/** Verifies durable control history without provisioning or writing to the remote. */
export function verifyGraftControlDatabase(configPath: string, remoteLogId: string): void {
  initializeGraftSqlite(configPath);
  const database = openClonedGraftDatabase(
    `control-verify-${randomUUID()}`,
    remoteLogId,
    graftControlDatabaseOperations,
  );
  try {
    requireGraftControlFormat(database);
  } finally {
    database.close();
  }
}

function ensurePublishedGraftControlDatabase(
  configPath: string,
  remoteLogId: string,
  database: DatabaseSync,
): void {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  if (tables.length === 0) {
    createGraftControlSchema(database);
    graftControlDatabaseOperations.push(database);
  } else {
    requireGraftControlFormat(database);
  }
  // A fresh clone proves the schema is remote, not merely in the publishing cache.
  verifyGraftControlDatabase(configPath, remoteLogId);
}

/** Creates the fleet control database and returns the remote log ID retained by deployment config. */
export function provisionGraftControlDatabase(configPath: string): string {
  initializeGraftSqlite(configPath);
  const database = openNewGraftDatabase(`control-provision-${randomUUID()}`);
  try {
    createGraftControlSchema(database);
    graftControlDatabaseOperations.push(database);
    return graftControlDatabaseOperations.readRemoteLogId(database);
  } finally {
    database.close();
  }
}
