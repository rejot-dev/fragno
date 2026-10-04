import type { DatabaseSync } from "node:sqlite";

/** Performs the Graft management pragmas used by one worker-owned SQLite connection. */
export type GraftDatabaseOperations = {
  clone(database: DatabaseSync, remoteLogId: string): void;
  pull(database: DatabaseSync): void;
  push(database: DatabaseSync): void;
  readRemoteLogId(database: DatabaseSync): string;
};

/** Creates a process-local Graft operations collaborator after import inside an object worker. */
export type GraftDatabaseOperationsFactory<TInput = unknown> = (
  input: TInput,
) => GraftDatabaseOperations;

/** Identifies an importable Graft operations factory and its structured-clonable input. */
export type ImportableGraftDatabaseOperations<TInput = unknown> = {
  moduleUrl: string;
  exportName: string;
  input: TInput;
};

/** Supplies main-thread control/provisioning operations and worker-importable object operations. */
export type GraftRuntimeDatabaseOperations<TInput = unknown> = {
  control: GraftDatabaseOperations;
  provisioning: GraftDatabaseOperations;
  worker: ImportableGraftDatabaseOperations<TInput>;
};

/** Declares worker-importable Graft operations without transferring functions across threads. */
export function defineGraftDatabaseOperations<TInput>(
  moduleUrl: URL,
  exportName: string,
  input: TInput,
): ImportableGraftDatabaseOperations<TInput> {
  if (moduleUrl.protocol !== "file:" || exportName.length === 0) {
    throw new Error(
      "GRAFT_DATABASE_OPERATIONS_INVALID_MODULE: expected a file URL and named factory export.",
    );
  }
  return { moduleUrl: moduleUrl.href, exportName, input };
}

/** Creates the production Graft operations implementation backed by SQLite management pragmas. */
export function createSqlitePragmaGraftDatabaseOperations(): GraftDatabaseOperations {
  return {
    clone(database, remoteLogId) {
      runGraftPragma(database, `PRAGMA graft_clone = ${quoteSqlString(remoteLogId)}`);
    },
    pull(database) {
      runGraftPragma(database, "PRAGMA graft_pull");
    },
    push(database) {
      runGraftPragma(database, "PRAGMA graft_push");
    },
    readRemoteLogId(database) {
      const info = readGraftPragmaText(database, "PRAGMA graft_info");
      const remote = /^Remote:\s+(\S+)$/m.exec(info)?.[1];
      if (!remote) {
        throw new Error("GRAFT_SQLITE_REMOTE_LOG_ID_MISSING");
      }
      return remote;
    },
  };
}

function runGraftPragma(database: DatabaseSync, sql: string): void {
  database.prepare(sql).all();
}

function readGraftPragmaText(database: DatabaseSync, sql: string): string {
  const row = database.prepare(sql).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== "string") {
    throw new Error(`GRAFT_SQLITE_PRAGMA_RESULT_INVALID:${sql}`);
  }
  return value;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
