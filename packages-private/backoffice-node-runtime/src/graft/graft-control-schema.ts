import type { DatabaseSync } from "node:sqlite";

/** Identifies the exact control database schema understood by this runtime version. */
export const GRAFT_CONTROL_FORMAT = 4;

/** Rejects control snapshots whose schema is not understood by this runtime. */
export function requireGraftControlFormat(database: DatabaseSync): void {
  const format = database
    .prepare("SELECT format FROM node_runtime_control_format WHERE singleton = 1")
    .get() as { format: number } | undefined;
  if (format?.format !== GRAFT_CONTROL_FORMAT) {
    throw new Error(`GRAFT_CONTROL_FORMAT_UNSUPPORTED:${String(format?.format)}`);
  }
}

/** Creates the durable fleet directory, ownership, lease, and command receipt tables. */
export function createGraftControlSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE node_runtime_control_format (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      format INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE node_runtime_object_directory (
      object_id TEXT PRIMARY KEY,
      remote_log_id TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE node_runtime_object_ownership (
      object_id TEXT PRIMARY KEY REFERENCES node_runtime_object_directory(object_id),
      epoch TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('unowned', 'restoring', 'ready')),
      owner_node_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      CHECK (
        (lifecycle = 'unowned' AND owner_node_id = '' AND claim_id = '') OR
        (lifecycle IN ('restoring', 'ready') AND owner_node_id <> '' AND claim_id <> '')
      )
    ) STRICT;
    CREATE TABLE node_runtime_node_lease (
      node_id TEXT PRIMARY KEY,
      process_generation TEXT NOT NULL,
      private_address TEXT NOT NULL,
      application_origin TEXT NOT NULL,
      compatibility_version INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      renewal_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE node_runtime_control_command_receipt (
      command_id TEXT PRIMARY KEY,
      command_name TEXT NOT NULL,
      command_input_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE node_runtime_object_alarm_work (
      object_id TEXT PRIMARY KEY REFERENCES node_runtime_object_directory(object_id),
      kind TEXT NOT NULL CHECK (kind IN ('reconcile', 'scheduled')),
      reconciliation_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      due_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      CHECK (
        (kind = 'reconcile' AND reconciliation_id <> '' AND installation_id = '' AND due_at_ms = 0) OR
        (kind = 'scheduled' AND reconciliation_id = '' AND installation_id <> '')
      )
    ) STRICT;
    CREATE INDEX node_runtime_node_lease_by_expiry
      ON node_runtime_node_lease (expires_at_ms, node_id);
    CREATE INDEX node_runtime_object_ownership_by_owner
      ON node_runtime_object_ownership (owner_node_id, object_id);
    CREATE INDEX node_runtime_control_command_receipt_by_creation
      ON node_runtime_control_command_receipt (created_at_ms, command_id);
    CREATE INDEX node_runtime_object_alarm_work_by_due
      ON node_runtime_object_alarm_work (kind, due_at_ms, object_id);
  `);
  database
    .prepare("INSERT INTO node_runtime_control_format (singleton, format) VALUES (1, ?)")
    .run(GRAFT_CONTROL_FORMAT);
}
