import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { createSqlitePragmaGraftDatabaseOperations } from "../../graft/graft-database-operations.ts";
import {
  initializeGraftSqlite,
  openClonedGraftDatabase,
  openNewGraftDatabase,
} from "../../graft/graft-sqlite.ts";

const command = process.argv[2];
const configPath = process.argv[3];
if (!command || !configPath) {
  throw new Error("GRAFT_CONFLICT_PROCESS_ARGUMENTS_MISSING");
}

initializeGraftSqlite(configPath);
const operations = createSqlitePragmaGraftDatabaseOperations();

if (command === "provision") {
  const database = openNewGraftDatabase(`conflict-provision-${randomUUID()}`);
  try {
    database.exec(`
      CREATE TABLE conflict_events (
        writer TEXT PRIMARY KEY
      ) STRICT;
    `);
    operations.push(database);
    writeResult({ remoteLogId: operations.readRemoteLogId(database) });
  } finally {
    database.close();
  }
} else {
  const remoteLogId = process.argv[4];
  const localTag = process.argv[5];
  if (!remoteLogId || !localTag) {
    throw new Error("GRAFT_CONFLICT_PROCESS_DATABASE_ARGUMENTS_MISSING");
  }

  if (command === "stage") {
    const writer = process.argv[6];
    if (!writer) {
      throw new Error("GRAFT_CONFLICT_PROCESS_WRITER_MISSING");
    }
    const database = openClonedGraftDatabase(localTag, remoteLogId, operations);
    try {
      database.prepare("INSERT INTO conflict_events (writer) VALUES (?)").run(writer);
      writeResult({ rows: readConflictRows(database) });
    } finally {
      database.close();
    }
  } else if (command === "push") {
    const database = openNewGraftDatabase(localTag);
    try {
      writeResult({
        outcome: capturePushOutcome(database),
        rows: readConflictRows(database),
        status: readGraftPragmaText(database, "PRAGMA graft_status"),
      });
    } finally {
      database.close();
    }
  } else if (command === "read") {
    const database = openClonedGraftDatabase(localTag, remoteLogId, operations);
    try {
      writeResult({ rows: readConflictRows(database) });
    } finally {
      database.close();
    }
  } else {
    throw new Error(`GRAFT_CONFLICT_PROCESS_COMMAND_UNKNOWN:${command}`);
  }
}

function capturePushOutcome(database: DatabaseSync): Record<string, unknown> {
  try {
    operations.push(database);
    return { kind: "succeeded" };
  } catch (error) {
    const record =
      typeof error === "object" && error !== null ? (error as Record<string, unknown>) : null;
    return {
      kind: "failed",
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      code: readErrorProperty(record, "code"),
      errcode: readErrorProperty(record, "errcode"),
      errstr: readErrorProperty(record, "errstr"),
    };
  }
}

function readErrorProperty(
  record: Record<string, unknown> | null,
  property: string,
): string | number | null {
  const value = record?.[property];
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function readConflictRows(database: DatabaseSync): string[] {
  return (
    database.prepare("SELECT writer FROM conflict_events ORDER BY writer").all() as {
      writer: string;
    }[]
  ).map((row) => row.writer);
}

function readGraftPragmaText(database: DatabaseSync, sql: string): string {
  const row = database.prepare(sql).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== "string") {
    throw new Error(`GRAFT_CONFLICT_PROCESS_PRAGMA_RESULT_INVALID:${sql}`);
  }
  return value;
}

function writeResult(result: unknown): void {
  process.stdout.write(`GRAFT_CONFLICT_RESULT:${JSON.stringify(result)}\n`);
}
