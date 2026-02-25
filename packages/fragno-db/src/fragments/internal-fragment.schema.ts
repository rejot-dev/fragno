import { schema, idColumn, column } from "../schema/create";

// Constants for Fragno's internal settings table
export const SETTINGS_TABLE_NAME = "fragno_db_settings" as const;
// FIXME: In some places we simply use empty string "" as namespace, which is not correct.
export const SETTINGS_NAMESPACE = "fragno-db-settings" as const;
export const SYSTEM_MIGRATION_VERSION_KEY = "system_migration_version" as const;
export const FRAGNO_DB_PACKAGE_VERSION_KEY = "fragno_db_package_version" as const;

export const internalSchema = schema("fragno_internal", (s) => {
  return s
    .addTable(SETTINGS_TABLE_NAME, (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("key", column("string"))
        .addColumn("value", column("string"))
        .createIndex("unique_key", ["key"], { unique: true });
    })
    .addTable("fragno_hooks", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("namespace", column("string"))
        .addColumn("hookName", column("string"))
        .addColumn("payload", column("json"))
        .addColumn("status", column("string")) // "pending" | "processing" | "completed" | "failed"
        .addColumn("attempts", column("integer").defaultTo(0))
        .addColumn("maxAttempts", column("integer").defaultTo(5))
        .addColumn("lastAttemptAt", column("timestamp").nullable())
        .addColumn("nextRetryAt", column("timestamp").nullable())
        .addColumn("error", column("string").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("nonce", column("string"))
        .createIndex("idx_namespace_status_retry", ["namespace", "status", "nextRetryAt"])
        .createIndex("idx_hooks_shard_status_retry", ["_shard", "status", "nextRetryAt"])
        .createIndex("idx_nonce", ["nonce"]);
    })
    .addTable("fragno_db_outbox", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("versionstamp", column("string"))
        .addColumn("uowId", column("string"))
        .addColumn("payload", column("json"))
        .addColumn("refMap", column("json").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_outbox_versionstamp", ["versionstamp"], { unique: true })
        .createIndex("idx_outbox_shard_versionstamp", ["_shard", "versionstamp"])
        .createIndex("idx_outbox_uow", ["uowId"]);
    })
    .addTable("fragno_db_outbox_mutations", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("entryVersionstamp", column("string"))
        .addColumn("mutationVersionstamp", column("string"))
        .addColumn("uowId", column("string"))
        .addColumn("schema", column("string"))
        .addColumn("table", column("string"))
        .addColumn("externalId", column("string"))
        .addColumn("op", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_outbox_mutations_entry", ["entryVersionstamp"])
        .createIndex("idx_outbox_mutations_shard_entry", ["_shard", "entryVersionstamp"])
        .createIndex("idx_outbox_mutations_key", [
          "schema",
          "table",
          "externalId",
          "entryVersionstamp",
        ])
        .createIndex("idx_outbox_mutations_uow", ["uowId"]);
    })
    .addTable("fragno_db_sync_requests", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("requestId", column("string"))
        .addColumn("status", column("string"))
        .addColumn("confirmedCommandIds", column("json"))
        .addColumn("conflictCommandId", column("string").nullable())
        .addColumn("baseVersionstamp", column("string").nullable())
        .addColumn("lastVersionstamp", column("string").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_sync_request_id", ["requestId"], { unique: true })
        .createIndex("idx_sync_requests_shard_request", ["_shard", "requestId"]);
    })
    .alterTable("fragno_hooks", (t) =>
      t.createIndex("idx_namespace_status_last_attempt", ["namespace", "status", "lastAttemptAt"]),
    );
});
