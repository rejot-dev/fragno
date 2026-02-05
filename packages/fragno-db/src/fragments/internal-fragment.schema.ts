import { schema, idColumn, column } from "../schema/create";

// Constants for Fragno's internal settings table
export const SETTINGS_TABLE_NAME = "fragno_db_settings" as const;
// FIXME: In some places we simply use empty string "" as namespace, which is not correct.
export const SETTINGS_NAMESPACE = "fragno-db-settings" as const;

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
        .createIndex("idx_outbox_uow", ["uowId"]);
    });
});
