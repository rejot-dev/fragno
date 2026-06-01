// Database schema for workflow instances, steps, and events.

import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const workflowsSchema = schema("workflows", (s) => {
  return (
    s
      // Per-run instance lifecycle and metadata.
      .addTable("workflow_instance", (t) => {
        return (
          t
            // External instance id (idColumn provides external string + internal bigint).
            .addColumn("id", idColumn())
            // Workflow registry key for routing and list queries.
            .addColumn("workflowName", column("string"))
            // Current status of the instance (active/waiting/paused/complete/errored/etc).
            .addColumn("status", column("string"))
            // Creation time for ordering and history cursoring.
            .addColumn(
              "createdAt",
              column("timestamp").defaultTo((b) => b.now()),
            )
            // Last state transition or metadata update time.
            .addColumn(
              "updatedAt",
              column("timestamp").defaultTo((b) => b.now()),
            )
            // When the workflow first began executing.
            .addColumn("startedAt", column("timestamp").nullable())
            // When the workflow reached a terminal status.
            .addColumn("completedAt", column("timestamp").nullable())
            // Stored workflow input parameters (validated, used by runner).
            .addColumn("params", column("json"))
            // Stored workflow output payload when completed.
            .addColumn("output", column("json").nullable())
            // Failure diagnostics for terminal errors.
            .addColumn("errorName", column("string").nullable())
            .addColumn("errorMessage", column("string").nullable())
            .createIndex("idx_workflow_instance_workflowName_id", ["workflowName", "id"], {
              unique: true,
            })
            // Powers status-filtered list queries with cursor-safe string/id ordering.
            .createIndex("idx_workflow_instance_workflowName_status_id", [
              "workflowName",
              "status",
              "id",
            ])
        );
      })
      // Durable step execution history and wait state.
      .addTable("workflow_step", (t) => {
        return (
          t
            // Internal step row id.
            .addColumn("id", idColumn())
            // Reference to workflow_instance (internal id).
            .addColumn("instanceRef", referenceColumn({ table: "workflow_instance" }))
            // Deterministic step key (type:name) for replay/idempotency.
            .addColumn("stepKey", column("string"))
            // Parent step key for nested step subtrees (null for top-level steps).
            .addColumn("parentStepKey", column("string").nullable())
            // Nesting depth (0 for top-level steps).
            .addColumn("depth", column("integer").defaultTo(0))
            // Human-readable step name as supplied by author.
            .addColumn("name", column("string"))
            // Step type (do/sleep/waitForEvent).
            .addColumn("type", column("string"))
            // Step status (waiting/completed/errored).
            .addColumn("status", column("string"))
            // Attempt counter used by retry logic.
            .addColumn("attempts", column("integer").defaultTo(0))
            // Total attempts allowed (for diagnostics and reporting).
            .addColumn("maxAttempts", column("integer"))
            // Timeout for waitForEvent (ms), persisted for history.
            .addColumn("timeoutMs", column("integer").nullable())
            // Next retry timestamp (if waiting for retry).
            .addColumn("nextRetryAt", column("timestamp").nullable())
            // Wake timestamp for sleep/waitForEvent timeouts.
            .addColumn("wakeAt", column("timestamp").nullable())
            // Event type awaited by waitForEvent.
            .addColumn("waitEventType", column("string").nullable())
            // Result payload for completed steps.
            .addColumn("result", column("json").nullable())
            // Error diagnostics for failed steps.
            .addColumn("errorName", column("string").nullable())
            .addColumn("errorMessage", column("string").nullable())
            // Creation timestamp (used for history ordering).
            .addColumn(
              "createdAt",
              column("timestamp").defaultTo((b) => b.now()),
            )
            // Last update timestamp (for status transitions).
            .addColumn(
              "updatedAt",
              column("timestamp").defaultTo((b) => b.now()),
            )
            .createIndex("idx_workflow_step_instanceRef_stepKey", ["instanceRef", "stepKey"], {
              unique: true,
            })
            .createIndex("idx_workflow_step_instanceRef_createdAt", ["instanceRef", "createdAt"])
            // Runner lookup for waiting steps on a given instance.
            .createIndex("idx_workflow_step_instanceRef_status_wakeAt", [
              "instanceRef",
              "status",
              "wakeAt",
            ])
        );
      })
      // External events delivered to waiting workflows.
      .addTable("workflow_event", (t) => {
        return (
          t
            // Internal event row id.
            .addColumn("id", idColumn())
            // Reference to workflow_instance (internal id).
            .addColumn("instanceRef", referenceColumn({ table: "workflow_instance" }))
            // Actor describes who emitted the event; typical values are "user" and "system".
            .addColumn("actor", column("string").defaultTo("user"))
            // Event type used to match waitForEvent.
            .addColumn("type", column("string"))
            // Payload attached to the event.
            .addColumn("payload", column("json").nullable())
            // Event creation time for ordering and filtering.
            .addColumn(
              "createdAt",
              column("timestamp").defaultTo((b) => b.now()),
            )
            // When the event was delivered/consumed by a step.
            .addColumn("deliveredAt", column("timestamp").nullable())
            // Step key that consumed the event (null if pending).
            .addColumn("consumedByStepKey", column("string").nullable())
            .createIndex("idx_workflow_event_instanceRef_createdAt", ["instanceRef", "createdAt"])
        );
      })
      .noOp("removed obsolete workflow_step -> workflow_instance addReference history")
      .noOp("removed obsolete workflow_event -> workflow_instance addReference history")
      // Ephemeral step-scoped emission bus rows for running workflow steps.
      .addTable("workflow_step_emission", (t) =>
        t
          .addColumn("id", idColumn())
          .addColumn("instanceRef", referenceColumn({ table: "workflow_instance" }))
          .addColumn("stepKey", column("string"))
          .addColumn("epoch", column("string"))
          .addColumn("sequence", column("integer"))
          .addColumn("actor", column("string").defaultTo("user"))
          .addColumn("payload", column("json").nullable())
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", [
            "instanceRef",
            "createdAt",
            "sequence",
            "id",
          ])
          .createIndex("idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id", [
            "instanceRef",
            "stepKey",
            "epoch",
            "createdAt",
            "sequence",
            "id",
          ])
          .createIndex("idx_workflow_step_emission_instance_actor_createdAt_sequence_id", [
            "instanceRef",
            "actor",
            "createdAt",
            "sequence",
            "id",
          ]),
      )
  );
});
