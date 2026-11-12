import type {
  AutomationEventMatcher,
  AutomationForwardSenders,
  AutomationRouteAction,
  AutomationRouteTrigger,
  AutomationSteward,
} from "@fragno-dev/backoffice-api/v0/automation";
import type {
  AutomationEvent,
  AutomationEventDefinition,
  AutomationRouteDispatchOutcome,
} from "@fragno-dev/backoffice-api/v0/events";
import type { IntegrationConnection } from "@fragno-dev/backoffice-api/v0/integrations";
import type { MarketplaceScope } from "@fragno-dev/backoffice-api/v0/marketplace";
import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

import type { AutomationEventSource } from "./event-sources";
import type { StoredAutomationRouteMetadata } from "./route-records";

/**
 * One page of `event-fold-replay`'s replay of stored events: a type's events after the cursor, which
 * is null for its first page. Defined with the table storing it, so reading the schema reads no
 * replay.
 */
export type EventFoldReplayPass = { source: string; eventType: string; cursor: string | null };

const jsonColumn = <T>() => column("json") as Column<"json", T, T>;

export const automationFragmentSchema = schema("automations", (s) => {
  return (
    s
      .addTable("kv_store", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("key", column("string"))
          .addColumn("value", column("string"))
          .addColumn("description", column("string").nullable())
          .addColumn("category", jsonColumn<string[]>().nullable())
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
      // Dropped below. Releases that replaced this with a noOp left it out of databases they created.
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
          .addColumn("priority", column("integer"))
          .addColumn("trigger", jsonColumn<AutomationRouteTrigger>())
          .addColumn("action", jsonColumn<AutomationRouteAction>())
          .addColumn("description", column("text").nullable())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn(
            "updatedAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_automation_route_priority_id", ["priority", "id"]);
      })
      .addTable("automation_route_schedule_state", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("initializationAt", column("timestamp").nullable())
          .addColumn("nextOccurrenceAt", column("timestamp").nullable())
          .createIndex("idx_automation_route_schedule_state_nextOccurrenceAt", [
            "nextOccurrenceAt",
            "id",
          ]);
      })
      .addTable("automation_event", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("scope", jsonColumn<AutomationEvent["scope"]>())
          .addColumn("source", column("string"))
          .addColumn("eventType", column("string"))
          .addColumn("occurredAt", column("timestamp"))
          .addColumn("payload", jsonColumn<AutomationEvent["payload"]>())
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
      })
      .addTable("automation_event_definition", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("source", column("string"))
          .addColumn("eventType", column("string"))
          .addColumn("label", column("string"))
          .addColumn("description", column("text").nullable())
          .addColumn(
            "payloadSchema",
            jsonColumn<AutomationEventDefinition["payloadSchema"]>().nullable(),
          )
          .addColumn(
            "actorSchema",
            jsonColumn<AutomationEventDefinition["actorSchema"]>().nullable(),
          )
          .addColumn(
            "subjectSchema",
            jsonColumn<AutomationEventDefinition["subjectSchema"]>().nullable(),
          )
          .addColumn("example", column("json").nullable())
          .addColumn("enabled", column("bool"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn(
            "updatedAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_automation_event_definition_source_type", ["source", "eventType"], {
            unique: true,
          });
      })
      // Dropped below. Releases that replaced this with a noOp left it out of databases they created.
      .addTable("marketplace_ingestion", (t) => {
        // `targetScopeKey` is the indexable encoding of the org, project, or user destination scope.
        return t
          .addColumn("id", idColumn())
          .addColumn("targetScopeKey", column("string"))
          .addColumn("listingId", column("string"))
          .addColumn("version", column("string"))
          .createIndex("idx_marketplace_ingestion_targetScopeKey_id", ["targetScopeKey", "id"]);
      })
      .addTable("external_identity_binding", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("source", column("string"))
          .addColumn("externalType", column("string"))
          .addColumn("externalId", column("string"))
          .addColumn("userId", column("string"))
          .addColumn("verifiedByClaimId", column("string"))
          .addColumn("boundAt", column("timestamp"))
          .addColumn("revokedAt", column("timestamp").nullable());
      })
      .addTable("external_identity_claim_consumption", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("bindingId", column("string"))
          .addColumn("userId", column("string"))
          .addColumn("acceptedBindingVersion", column("integer"))
          .addColumn("acceptedAt", column("timestamp"))
          .createIndex("idx_external_identity_claim_consumption_binding", ["bindingId"]);
      })
      .alterTable("automation_route", (t) => {
        return t.addColumn("metadata", jsonColumn<StoredAutomationRouteMetadata>().nullable());
      })
      .addTable("automation_event_source", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("source", column("string"))
          .addColumn("label", column("string"))
          .addColumn("description", column("text"))
          .addColumn("category", jsonColumn<AutomationEventSource["category"]>())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn(
            "updatedAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_automation_event_source_source", ["source"], {
            unique: true,
          });
      })
      .alterTable("automation_event", (t) =>
        t.addColumn("scopeRestriction", jsonColumn<AutomationEvent["scope"]>().nullable()),
      )
      // Null for events recorded before causation was tracked. `rootEventId` duplicates the root
      // that causation implies, so one indexed read can load a whole causal tree.
      .alterTable("automation_event", (t) =>
        t
          .addColumn("causation", jsonColumn<AutomationEvent["causation"]>().nullable())
          .addColumn("rootEventId", column("string").nullable())
          .createIndex("idx_automation_event_rootEventId_occurredAt", [
            "rootEventId",
            "occurredAt",
            "id",
          ]),
      )
      .addTable("automation_route_dispatch", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("eventId", column("string"))
          .addColumn("rootEventId", column("string"))
          .addColumn("routeId", column("string"))
          // Routes can be renamed or deleted after they act.
          .addColumn("routeName", column("string"))
          .addColumn("outcome", jsonColumn<AutomationRouteDispatchOutcome>())
          .addColumn("dispatchedAt", column("timestamp"))
          .createIndex("idx_automation_route_dispatch_rootEventId_dispatchedAt", [
            "rootEventId",
            "dispatchedAt",
            "id",
          ]),
      )
      // Routes are recorded when an event matches them, before they act, so one that keeps failing
      // stays visible. Rows recorded before then are completed. `dispatchedAt` is when the event
      // was matched. Written and read only through `route-dispatches-storage-runtime`.
      .alterTable("automation_route_dispatch", (t) =>
        t
          .addColumn("status", column("string").defaultTo("completed"))
          .alterColumn("outcome")
          .nullable()
          .addColumn("failedAttempts", column("integer").defaultTo(0))
          .addColumn("error", column("text").nullable())
          .createIndex("idx_automation_route_dispatch_eventId", ["eventId"]),
      )
      // False from when an event is stored until its routes are matched and recorded. Events
      // stored before then had their routes matched.
      .alterTable("automation_event", (t) =>
        t.addColumn("routesMatched", column("bool").defaultTo(true)),
      )
      // Lists the routes in one state, such as failed, newest match first.
      .alterTable("automation_route_dispatch", (t) =>
        t.createIndex("idx_automation_route_dispatch_status_dispatchedAt", [
          "status",
          "dispatchedAt",
          "id",
        ]),
      )
      // A workspace installs a listing at most once, so the listing id identifies the installation.
      // Written and read only through `package-installations-storage-runtime`.
      .addTable("package_installation", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("marketplace", jsonColumn<MarketplaceScope>())
          .addColumn("version", column("string"))
          .addColumn("installationRoot", column("string"))
          .addColumn("permissions", jsonColumn<BackofficePermissionRequirement[]>())
          .addColumn("settings", jsonColumn<Record<string, unknown>>())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn(
            "updatedAt",
            column("timestamp").defaultTo((b) => b.now()),
          ),
      )
      // Null for definitions created before stewardship, which belong to members. Written and read
      // only through `event-definitions-storage-runtime`.
      .alterTable("automation_event_definition", (t) =>
        t.addColumn("steward", jsonColumn<AutomationSteward>().nullable()),
      )
      // The install run that last wrote the installation, so a run can tell whether another one, or
      // an uninstall, changed it since it read it. Empty for installations recorded otherwise.
      .alterTable("package_installation", (t) =>
        t.addColumn("operation", column("string").defaultTo("")),
      )
      // Sandboxes moved to the SandboxManager object.
      .dropTable("sandbox_instance")
      // Installations are recorded in marketplace-lock.json.
      .dropTable("marketplace_ingestion")
      // A /workspace folder this scope shares with another; deleting it revokes the share. The
      // share's ID is the row's. Written and read only through `shares-storage-runtime`.
      .addTable("file_share", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("path", column("string"))
          .addColumn("target", jsonColumn<BackofficeRoutableScope>())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          ),
      )
      // A share another scope offered and this one accepted, mounted at /shared/<name>/. The sharing
      // scope's `file_share` row stays the authority: this row only says where to look.
      .addTable("accepted_file_share", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("source", jsonColumn<BackofficeRoutableScope>())
          .addColumn("path", column("string"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          ),
      )
      // Where this scope mounts the share, which it chose on accepting; the share's ID unless it
      // named it. The default only lets the column be added: every share is accepted with a name.
      .alterTable("accepted_file_share", (t) =>
        t
          .addColumn("name", column("string").defaultTo(""))
          .createIndex("idx_accepted_file_share_name", ["name"], { unique: true }),
      )
      // Shares open a /workspace folder or the blobs under a key prefix, which `path` then holds.
      // The tables keep their names from before blob shares. Existing shares are folders.
      .alterTable("file_share", (t) => t.addColumn("kind", column("string").defaultTo("folder")))
      .alterTable("accepted_file_share", (t) =>
        t.addColumn("kind", column("string").defaultTo("folder")),
      )
      // Which scopes of other owners may forward events into this one, and which of their events
      // it takes in. Written and read only through `forward-accepts-storage-runtime`.
      .addTable("automation_forward_accept", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("enabled", column("bool"))
          .addColumn("senders", jsonColumn<AutomationForwardSenders>())
          .addColumn("matcher", jsonColumn<AutomationEventMatcher>().nullable())
          .addColumn("description", column("text").nullable())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn(
            "updatedAt",
            column("timestamp").defaultTo((b) => b.now()),
          ),
      )
      // What the scope's `pi` and `integrations` events record, folded as each event is stored, so
      // agents and connections outlive the events that recorded them. Written only through
      // `event-projections`.
      // Keyed by agent name: every agent with events, as `PiAgentState` records it, and the name
      // people read. `definition` is null after a deletion; the definition columns are all null
      // without a definition event.
      .addTable("pi_agent", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("displayName", column("string"))
          .addColumn("latestKind", column("string"))
          .addColumn("latestAt", column("timestamp"))
          .addColumn("definition", jsonColumn<PiAgentDefinition>().nullable())
          .addColumn("definitionAt", column("timestamp").nullable())
          .addColumn("definitionEventId", column("string").nullable())
          .addColumn("paused", column("bool").nullable())
          .addColumn("pauseAt", column("timestamp").nullable())
          .addColumn("running", column("integer"))
          .addColumn("queued", column("integer"))
          .addColumn("steering", column("integer")),
      )
      // Keyed by `piAgentRequestKey`, so an agent's counts change by what one event did.
      .addTable("pi_agent_request", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("started", column("bool"))
          .addColumn("ended", column("bool"))
          .addColumn("waiting", column("bool"))
          .addColumn("steer", column("bool"))
          .addColumn("dequeued", column("bool")),
      )
      // Keyed by the event that ended the turn.
      .addTable("pi_agent_turn", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("agentName", column("string"))
          .addColumn("outcome", column("string"))
          .addColumn("endedAt", column("timestamp"))
          .createIndex("idx_pi_agent_turn_endedAt", ["endedAt"]),
      )
      // Keyed by connection ID. `name` and `authMethod` are the latest label's, from `labelAt`.
      .addTable("integration_connection", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("service", column("string"))
          .addColumn("kind", column("string"))
          .addColumn("state", column("string"))
          .addColumn("eventId", column("string"))
          .addColumn("changedAt", column("timestamp"))
          .addColumn("name", column("string").nullable())
          .addColumn("authMethod", column("string").nullable())
          .addColumn("labelAt", column("timestamp").nullable())
          .addColumn("displayName", column("string"))
          .addColumn("kindLabel", column("string")),
      )
      // Keyed by the event that reported the change: every connection's state history.
      .addTable("integration_connection_change", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("connectionId", column("string"))
          .addColumn("service", column("string"))
          .addColumn("kind", column("string"))
          .addColumn("state", column("string"))
          .addColumn(
            "label",
            jsonColumn<Pick<IntegrationConnection, "name" | "authMethod">>().nullable(),
          )
          .addColumn("occurredAt", column("timestamp"))
          .createIndex("idx_integration_connection_change_connection", [
            "connectionId",
            "occurredAt",
          ]),
      )
      // One row, which `event-fold-replay` keeps: the pass its replay of stored events takes next.
      .addTable("event_fold_replay", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("next", jsonColumn<EventFoldReplayPass>().nullable()),
      )
      // Where a type's events hold the key of what they are about, or null when they hold none.
      .alterTable("automation_event_definition", (t) =>
        t.addColumn("keyPath", column("string").nullable()),
      )
      // Each key's state: a copy of the latest event of its type with that key, which `event-state`
      // keeps. A copy, so the state outlives the events it was read from.
      .addTable("automation_event_state", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("source", column("string"))
          .addColumn("eventType", column("string"))
          .addColumn("key", column("string"))
          .addColumn("keyPath", column("string"))
          .addColumn("eventId", column("string"))
          .addColumn("payload", jsonColumn<AutomationEvent["payload"]>())
          .addColumn("occurredAt", column("timestamp"))
          .addColumn("storedAt", column("timestamp"))
          .createIndex(
            "idx_automation_event_state_source_type_key",
            ["source", "eventType", "key"],
            {
              unique: true,
            },
          ),
      )
      // Turns and connection changes are read from the events that record them.
      .dropTable("pi_agent_turn")
      .dropTable("integration_connection_change")
  );
});
