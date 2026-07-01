import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

import type { AutomationEvent } from "./contracts";
import type { AutomationEventMatcher, AutomationRouteAction } from "./routing";

const jsonColumn = <T>() => column("json") as Column<"json", T, T>;

export const automationFragmentSchema = schema("automations", (s) => {
  return s
    .addTable("kv_store", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("key", column("string"))
        .addColumn("value", column("string"))
        .addColumn("description", column("string").nullable())
        .addColumn("category", column("json").nullable())
        .addColumn("actor", column("json").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_kv_store_key", ["key"], {
          unique: true,
        });
    })
    .addTable("project", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("slug", column("string"))
        .addColumn("name", column("string"))
        .addColumn("description", column("text").nullable())
        .addColumn("archivedAt", column("timestamp").nullable())
        .addColumn("createdByUserId", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_project_slug", ["slug"], { unique: true });
    })
    .addTable("sandbox_instance", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("provider", column("string"))
        .addColumn("status", column("string"))
        .addColumn("workflowInstanceId", column("string").nullable())
        .addColumn("keepAlive", column("bool"))
        .addColumn("sleepAfter", column("json").nullable())
        .addColumn("startupCommand", column("text"))
        .addColumn("startupTimeoutMs", column("integer").nullable())
        .addColumn("startedAt", column("timestamp").nullable())
        .addColumn("expectedStopAt", column("timestamp").nullable())
        .addColumn("stoppedAt", column("timestamp").nullable())
        .addColumn("lastError", column("text").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_sandbox_instance_provider", ["provider"])
        .createIndex("idx_sandbox_instance_status", ["status"])
        .createIndex("idx_sandbox_instance_workflowInstanceId", ["workflowInstanceId"]);
    })
    .addTable("automation_route", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("enabled", column("bool"))
        .addColumn("source", column("string"))
        .addColumn("eventType", column("string"))
        .addColumn("matcher", jsonColumn<AutomationEventMatcher>().nullable())
        .addColumn("action", jsonColumn<AutomationRouteAction>())
        .addColumn("priority", column("integer"))
        .addColumn("description", column("text").nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_automation_route_enabled_source_type", ["enabled", "source", "eventType"])
        .createIndex("idx_automation_route_priority_id", ["priority", "id"]);
    })
    .addTable("automation_event", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("scope", jsonColumn<AutomationEvent["scope"]>())
        .addColumn("source", column("string"))
        .addColumn("eventType", column("string"))
        .addColumn("occurredAt", column("timestamp"))
        .addColumn("payload", jsonColumn<AutomationEvent["payload"]>())
        .addColumn("actor", jsonColumn<AutomationEvent["actor"]>())
        .addColumn("actors", jsonColumn<AutomationEvent["actors"]>())
        .addColumn("subject", jsonColumn<AutomationEvent["subject"]>().nullable())
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_automation_event_source_type_occurredAt", [
          "source",
          "eventType",
          "occurredAt",
          "id",
        ])
        .createIndex("idx_automation_event_occurredAt_id", ["occurredAt", "id"]);
    });
});
