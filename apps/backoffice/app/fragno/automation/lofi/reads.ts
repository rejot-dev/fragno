import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import type { AnyTable } from "@fragno-dev/db/schema";
import { lofiSqliteTableName, type LofiSqliteReader } from "@fragno-dev/lofi/sqlite";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import type { AutomationWorkflowRun } from "@/routes/backoffice/automations/script-view/workflow-run-presentation";
import {
  automationWorkflowRunsFromRecords,
  type WorkflowRunRecordSelector,
} from "@/routes/backoffice/automations/script-view/workflow-run-records";

import { CODEMODE_WORKFLOW } from "../engine/codemode-invocation";
import { automationRouteSteward, type StoredAutomationRouteMetadata } from "../route-records";
import { automationFragmentSchema } from "../schema";

const automationTable = (name: keyof typeof automationFragmentSchema.tables) =>
  `"${lofiSqliteTableName({ schema: automationFragmentSchema }, name)}"`;
const workflowTable = (name: keyof typeof workflowsSchema.tables) =>
  `"${lofiSqliteTableName({ schema: workflowsSchema }, name)}"`;

/** The scope's routes by priority, with when each scheduled route next fires. */
export function readAutomationRoutes(reader: LofiSqliteReader): AutomationRouteDefinition[] {
  const route = automationFragmentSchema.tables.automation_route.columns;
  const schedule = automationFragmentSchema.tables.automation_route_schedule_state.columns;
  const rows = reader.query({
    sql: `SELECT "route"."id", "route"."name", "route"."enabled", "route"."priority",
            "route"."trigger", "route"."action", "route"."description", "route"."metadata",
            "schedule"."nextOccurrenceAt"
          FROM ${automationTable("automation_route")} AS "route"
          LEFT JOIN ${automationTable("automation_route_schedule_state")} AS "schedule"
            ON "schedule"."id" = "route"."id"
          ORDER BY "route"."priority", "route"."id"`,
    params: [],
    columns: {
      id: "text",
      name: route.name,
      enabled: route.enabled,
      priority: route.priority,
      trigger: route.trigger,
      action: route.action,
      description: route.description,
      metadata: route.metadata,
      // NULL for a route without a schedule state.
      nextOccurrenceAt: schedule.nextOccurrenceAt,
    },
  });
  // Only the automations fragment writes routes, so their JSON columns hold the shapes it persists.
  return (
    rows as (Omit<AutomationRouteDefinition, "nextOccurrenceAt" | "steward" | "metadata"> & {
      metadata: StoredAutomationRouteMetadata | null;
      nextOccurrenceAt: Date | null;
    })[]
  ).map(({ metadata, ...route }) => ({
    ...route,
    steward: automationRouteSteward(metadata),
    nextOccurrenceAt: route.nextOccurrenceAt?.toISOString() ?? null,
  }));
}

/** Every run, with what the dashboard reports about it. */
export function readWorkflowRunSummaries(reader: LofiSqliteReader) {
  const instance = workflowsSchema.tables.workflow_instance.columns;
  return reader.query({
    sql: `SELECT "id", "instanceId", "workflowName", "remoteWorkflowName", "status", "errorName",
            "errorMessage", "createdAt", "updatedAt", "completedAt"
          FROM ${workflowTable("workflow_instance")}`,
    params: [],
    columns: {
      id: "text",
      instanceId: instance.instanceId,
      workflowName: instance.workflowName,
      remoteWorkflowName: instance.remoteWorkflowName,
      status: instance.status,
      errorName: instance.errorName,
      errorMessage: instance.errorMessage,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      completedAt: instance.completedAt,
    },
  });
}

/** Which of the Codemode runs named by `instanceIds` have recorded a step, by instance ID. */
export function readStartedCodemodeRuns(
  reader: LofiSqliteReader,
  { instanceIds }: { instanceIds: string[] },
): string[] {
  if (instanceIds.length === 0) {
    return [];
  }
  const { workflow_instance } = workflowsSchema.tables;
  // Steps reference a run by its internal ID.
  const internalId = `"${workflow_instance.getInternalIdColumn().name}"`;
  const rows = reader.query({
    sql: `SELECT "instanceId" FROM ${workflowTable("workflow_instance")} AS "instance"
          WHERE "workflowName" = ? AND "instanceId" IN (${instanceIds.map(() => "?").join(", ")})
            AND EXISTS (SELECT 1 FROM ${workflowTable("workflow_step")} AS "step"
              WHERE "step"."instanceRef" = "instance".${internalId})
          ORDER BY "instanceId"`,
    params: [CODEMODE_WORKFLOW, ...instanceIds],
    columns: { instanceId: workflow_instance.columns.instanceId },
  });
  return rows.map(({ instanceId }) => instanceId);
}

/** Which runs a run read selects, as `workflowRunRecordsQuery` selects them. */
function selectedRuns(selector: WorkflowRunRecordSelector): { where: string; params: string[] } {
  switch (selector.type) {
    case "active-codemode":
      return {
        where: `"workflowName" = ? AND "status" IN ('active', 'waiting', 'paused')`,
        params: [CODEMODE_WORKFLOW],
      };
    case "waiting":
      return { where: `"status" = 'waiting'`, params: [] };
    case "instance":
      return {
        where: `"workflowName" = ? AND "instanceId" = ?`,
        params: [selector.workflowName, selector.instanceId],
      };
  }
  throw new Error("Unsupported workflow run selector.");
}

/**
 * The selected runs in full, most recently updated first, as `workflowRunRecordsQuery` reads them:
 * each with its steps, events, and step emissions in the order they were recorded.
 *
 * Rows a run's tick writes share one `createdAt`, so ties break by the replica's internal ID, which
 * follows the order the backend wrote them in. Their own IDs are random.
 */
export function readWorkflowRuns(
  reader: LofiSqliteReader,
  selector: WorkflowRunRecordSelector,
): AutomationWorkflowRun[] {
  const { workflow_instance, workflow_step, workflow_event, workflow_step_emission } =
    workflowsSchema.tables;
  const instance = workflow_instance.columns;
  const step = workflow_step.columns;
  const event = workflow_event.columns;
  const emission = workflow_step_emission.columns;
  // Rows reference a run by its internal ID.
  const internalId = `"${workflow_instance.getInternalIdColumn().name}"`;
  const writeOrder = (table: AnyTable) => `"${table.getInternalIdColumn().name}"`;
  const { where, params } = selectedRuns(selector);
  const selected = `SELECT ${internalId} FROM ${workflowTable("workflow_instance")} WHERE ${where}`;

  const instances = reader.query({
    sql: `SELECT ${internalId} AS "ref", "id", "instanceId", "workflowName",
              "remoteWorkflowName", "status", "params", "output", "errorName", "errorMessage",
              "createdAt", "updatedAt", "startedAt", "completedAt"
            FROM ${workflowTable("workflow_instance")}
            WHERE ${where}
            ORDER BY "updatedAt" DESC, "id" DESC`,
    params,
    columns: {
      ref: "integer",
      id: "text",
      instanceId: instance.instanceId,
      workflowName: instance.workflowName,
      remoteWorkflowName: instance.remoteWorkflowName,
      status: instance.status,
      params: instance.params,
      output: instance.output,
      errorName: instance.errorName,
      errorMessage: instance.errorMessage,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
      startedAt: instance.startedAt,
      completedAt: instance.completedAt,
    },
  });
  const steps = reader.query({
    sql: `SELECT "instanceRef" AS "ref", "id", "stepKey", "parentStepKey", "name", "type",
              "status", "committedByExecutionId", "attempts", "maxAttempts", "waitEventType",
              "result", "errorName", "errorMessage", "createdAt", "updatedAt"
            FROM ${workflowTable("workflow_step")}
            WHERE "instanceRef" IN (${selected})
            ORDER BY "createdAt", ${writeOrder(workflow_step)}`,
    params,
    columns: {
      ref: "integer",
      id: "text",
      stepKey: step.stepKey,
      parentStepKey: step.parentStepKey,
      name: step.name,
      type: step.type,
      status: step.status,
      committedByExecutionId: step.committedByExecutionId,
      attempts: step.attempts,
      maxAttempts: step.maxAttempts,
      waitEventType: step.waitEventType,
      result: step.result,
      errorName: step.errorName,
      errorMessage: step.errorMessage,
      createdAt: step.createdAt,
      updatedAt: step.updatedAt,
    },
  });
  const events = reader.query({
    sql: `SELECT "instanceRef" AS "ref", "id", "actor", "type", "payload", "createdAt",
              "deliveredAt", "consumedByStepKey"
            FROM ${workflowTable("workflow_event")}
            WHERE "instanceRef" IN (${selected})
            ORDER BY "createdAt", ${writeOrder(workflow_event)}`,
    params,
    columns: {
      ref: "integer",
      id: "text",
      actor: event.actor,
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt,
      deliveredAt: event.deliveredAt,
      consumedByStepKey: event.consumedByStepKey,
    },
  });
  const emissions = reader.query({
    sql: `SELECT "instanceRef" AS "ref", "id", "actor", "stepKey", "executionId", "epoch",
              "sequence", "payload", "createdAt"
            FROM ${workflowTable("workflow_step_emission")}
            WHERE "instanceRef" IN (${selected})
            ORDER BY "createdAt", "sequence", ${writeOrder(workflow_step_emission)}`,
    params,
    columns: {
      ref: "integer",
      id: "text",
      actor: emission.actor,
      stepKey: emission.stepKey,
      executionId: emission.executionId,
      epoch: emission.epoch,
      sequence: emission.sequence,
      payload: emission.payload,
      createdAt: emission.createdAt,
    },
  });

  const byRun = <T extends { ref: number }>(rows: readonly T[]) => {
    const groups = new Map<number, Omit<T, "ref">[]>();
    for (const { ref, ...row } of rows) {
      const group = groups.get(ref);
      if (group) {
        group.push(row);
      } else {
        groups.set(ref, [row]);
      }
    }
    return groups;
  };
  const [stepsByRun, eventsByRun, emissionsByRun] = [byRun(steps), byRun(events), byRun(emissions)];
  return automationWorkflowRunsFromRecords(
    instances.map(({ ref, ...run }) => ({
      ...run,
      workflowSteps: stepsByRun.get(ref) ?? [],
      workflowEvents: eventsByRun.get(ref) ?? [],
      workflowStepEmissions: emissionsByRun.get(ref) ?? [],
    })),
  );
}

/**
 * What the orchestration graph draws besides its records: the routes, and the source and type of
 * every event that occurred since `since`, in epoch milliseconds, once per event so the graph can
 * count them.
 */
export function readOrchestrationGraphInputs(
  reader: LofiSqliteReader,
  { since }: { since: number },
) {
  return {
    routes: readAutomationRoutes(reader),
    recentEvents: reader.query({
      sql: `SELECT "source", "eventType"
            FROM ${automationTable("automation_event")}
            WHERE "occurredAt" >= ?`,
      params: [since],
      columns: {
        source: automationFragmentSchema.tables.automation_event.columns.source,
        eventType: automationFragmentSchema.tables.automation_event.columns.eventType,
      },
    }),
  };
}

/** The scope's own event sources. Registered capabilities describe the rest. */
export function readAutomationEventSources(reader: LofiSqliteReader) {
  const source = automationFragmentSchema.tables.automation_event_source.columns;
  return reader.query({
    sql: `SELECT "source" AS "id", "label", "description"
          FROM ${automationTable("automation_event_source")}`,
    params: [],
    columns: { id: source.source, label: source.label, description: source.description },
  });
}

/** The scope's own event definitions. Registered capabilities describe the rest. */
export function readAutomationEventDefinitions(reader: LofiSqliteReader) {
  const definition = automationFragmentSchema.tables.automation_event_definition.columns;
  return reader.query({
    sql: `SELECT "source", "eventType", "label", "payloadSchema"
          FROM ${automationTable("automation_event_definition")}`,
    params: [],
    columns: {
      source: definition.source,
      eventType: definition.eventType,
      label: definition.label,
      payloadSchema: definition.payloadSchema,
    },
  });
}

/** The runs in one of `statuses`, with what names the workflow each runs. */
export function readWorkflowsInStatus(reader: LofiSqliteReader, statuses: readonly string[]) {
  const instance = workflowsSchema.tables.workflow_instance.columns;
  return reader.query({
    sql: `SELECT "workflowName", "remoteWorkflowName", "params"
          FROM ${workflowTable("workflow_instance")}
          WHERE "status" IN (${statuses.map(() => "?").join(", ")})`,
    params: [...statuses],
    columns: {
      workflowName: instance.workflowName,
      remoteWorkflowName: instance.remoteWorkflowName,
      params: instance.params,
    },
  });
}

/** The statuses of runs that have not finished. */
export const ACTIVE_WORKFLOW_STATUSES = ["active", "waiting", "paused"];

/**
 * What the orchestration graph reads besides routes and recent events: the scope's own event
 * sources and definitions, and the runs that have not finished.
 */
export function readOrchestrationRecords(reader: LofiSqliteReader) {
  return {
    eventSources: readAutomationEventSources(reader),
    eventDefinitions: readAutomationEventDefinitions(reader),
    activeWorkflows: readWorkflowsInStatus(reader, ACTIVE_WORKFLOW_STATUSES),
  };
}

/** The latest `limit` events of one type, newest first. */
export function readLatestEventsOfType(
  reader: LofiSqliteReader,
  { source, eventType, limit }: { source: string; eventType: string; limit: number },
) {
  const event = automationFragmentSchema.tables.automation_event.columns;
  return reader.query({
    sql: `SELECT "id", "occurredAt", "subject", "payload"
          FROM ${automationTable("automation_event")}
          WHERE "source" = ? AND "eventType" = ?
          ORDER BY "occurredAt" DESC, "id" DESC
          LIMIT ?`,
    params: [source, eventType, limit],
    columns: {
      id: "text",
      occurredAt: event.occurredAt,
      subject: event.subject,
      payload: event.payload,
    },
  });
}
