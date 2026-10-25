import type { AutomationRouteDefinition } from "@fragno-dev/backoffice-api/v0/automation";
import { lofiSqliteTableName, type LofiSqliteReplica } from "@fragno-dev/lofi/sqlite";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import type { AutomationWorkflowRun } from "@/routes/backoffice/automations/script-view/workflow-run-presentation";
import {
  automationWorkflowRunsFromRecords,
  type WorkflowRunRecordSelector,
} from "@/routes/backoffice/automations/script-view/workflow-run-records";

import { CODEMODE_WORKFLOW } from "../engine/codemode-invocation";
import { automationFragmentSchema } from "../schema";
import { automationRoutesFromRecords } from "../tanstack/use-automation-routes";

const automationTable = (name: keyof typeof automationFragmentSchema.tables) =>
  `"${lofiSqliteTableName({ schema: automationFragmentSchema }, name)}"`;
const workflowTable = (name: keyof typeof workflowsSchema.tables) =>
  `"${lofiSqliteTableName({ schema: workflowsSchema }, name)}"`;

/** The scope's routes by priority, with when each scheduled route next fires. */
export async function readAutomationRoutes(
  replica: LofiSqliteReplica,
): Promise<AutomationRouteDefinition[]> {
  const route = automationFragmentSchema.tables.automation_route.columns;
  const schedule = automationFragmentSchema.tables.automation_route_schedule_state.columns;
  const rows = await replica.query({
    sql: `SELECT "route"."id", "route"."name", "route"."enabled", "route"."priority",
            "route"."trigger", "route"."action", "route"."description",
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
      // NULL for a route without a schedule state.
      nextOccurrenceAt: schedule.nextOccurrenceAt,
    },
  });
  return automationRoutesFromRecords(rows as Parameters<typeof automationRoutesFromRecords>[0]);
}

/** Every run, with what the dashboard reports about it. */
export async function readWorkflowRunSummaries(replica: LofiSqliteReplica) {
  const instance = workflowsSchema.tables.workflow_instance.columns;
  return await replica.query({
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
 */
export async function readWorkflowRuns(
  replica: LofiSqliteReplica,
  selector: WorkflowRunRecordSelector,
): Promise<AutomationWorkflowRun[]> {
  const { workflow_instance, workflow_step, workflow_event, workflow_step_emission } =
    workflowsSchema.tables;
  const instance = workflow_instance.columns;
  const step = workflow_step.columns;
  const event = workflow_event.columns;
  const emission = workflow_step_emission.columns;
  // Rows reference a run by its internal ID.
  const internalId = `"${workflow_instance.getInternalIdColumn().name}"`;
  const { where, params } = selectedRuns(selector);
  const selected = `SELECT ${internalId} FROM ${workflowTable("workflow_instance")} WHERE ${where}`;

  const [instances, steps, events, emissions] = await Promise.all([
    replica.query({
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
    }),
    replica.query({
      sql: `SELECT "instanceRef" AS "ref", "id", "stepKey", "parentStepKey", "name", "type",
              "status", "committedByExecutionId", "attempts", "maxAttempts", "waitEventType",
              "result", "errorName", "errorMessage", "createdAt", "updatedAt"
            FROM ${workflowTable("workflow_step")}
            WHERE "instanceRef" IN (${selected})
            ORDER BY "createdAt", "id"`,
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
    }),
    replica.query({
      sql: `SELECT "instanceRef" AS "ref", "id", "actor", "type", "payload", "createdAt",
              "deliveredAt", "consumedByStepKey"
            FROM ${workflowTable("workflow_event")}
            WHERE "instanceRef" IN (${selected})
            ORDER BY "createdAt", "id"`,
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
    }),
    replica.query({
      sql: `SELECT "instanceRef" AS "ref", "id", "actor", "stepKey", "executionId", "epoch",
              "sequence", "payload", "createdAt"
            FROM ${workflowTable("workflow_step_emission")}
            WHERE "instanceRef" IN (${selected})
            ORDER BY "createdAt", "sequence", "id"`,
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
    }),
  ]);

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

/** The events that occurred since `since`, as the dashboard counts them. */
export async function readAutomationEventsSince(replica: LofiSqliteReplica, since: Date) {
  const event = automationFragmentSchema.tables.automation_event.columns;
  return await replica.query({
    sql: `SELECT "source", "eventType", "occurredAt"
          FROM ${automationTable("automation_event")}
          WHERE "occurredAt" >= ?`,
    params: [since.getTime()],
    columns: { source: event.source, eventType: event.eventType, occurredAt: event.occurredAt },
  });
}

/** The scope's own event sources. Registered capabilities describe the rest. */
export async function readAutomationEventSources(replica: LofiSqliteReplica) {
  const source = automationFragmentSchema.tables.automation_event_source.columns;
  return await replica.query({
    sql: `SELECT "source" AS "id", "label", "description"
          FROM ${automationTable("automation_event_source")}`,
    params: [],
    columns: { id: source.source, label: source.label, description: source.description },
  });
}

/** The scope's own event definitions. Registered capabilities describe the rest. */
export async function readAutomationEventDefinitions(replica: LofiSqliteReplica) {
  const definition = automationFragmentSchema.tables.automation_event_definition.columns;
  return await replica.query({
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
export async function readWorkflowsInStatus(
  replica: LofiSqliteReplica,
  statuses: readonly string[],
) {
  const instance = workflowsSchema.tables.workflow_instance.columns;
  return await replica.query({
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

/** The latest `limit` events of one type, newest first. */
export async function readLatestEventsOfType(
  replica: LofiSqliteReplica,
  { source, eventType, limit }: { source: string; eventType: string; limit: number },
) {
  const event = automationFragmentSchema.tables.automation_event.columns;
  return await replica.query({
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
