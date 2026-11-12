import type {
  AutomationForwardAccept,
  AutomationRouteDefinition,
} from "@fragno-dev/backoffice-api/v0/automation";
import type {
  AutomationEvent,
  AutomationEventCausation,
  AutomationRouteDispatchOutcome,
} from "@fragno-dev/backoffice-api/v0/events";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { AnyTable } from "@fragno-dev/db/schema";
import { lofiSqliteTableName, type LofiSqliteReader } from "@fragno-dev/lofi/sqlite";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import {
  PI_AUTOMATION_SOURCE,
  PI_TURN_AUTOMATION_EVENTS,
  readPiAgentEvent,
} from "@/fragno/backoffice-capabilities/capabilities/pi";
import { BUILT_IN_PI_AGENT_DEFINITIONS } from "@/fragno/pi/agent/agent-definitions";
import {
  piAgentRecord,
  piAgentTurnEndedBy,
  type PiAgentRecord,
  type PiAgentTurnRecord,
} from "@/fragno/pi/agent/pi-agent-records";
import {
  integrationConnectionsOfStates,
  readIntegrationConnectionStateChange,
  type IntegrationConnectionEventState,
  type IntegrationConnectionRecord,
  type IntegrationConnectionStateChange,
} from "@/fragno/runtime-tools/families/integrations/integration-connections";
import {
  INTEGRATIONS_EVENT_SOURCE,
  integrationConnectionEvents,
} from "@/fragno/runtime-tools/families/integrations/integration-events";
import type { AutomationWorkflowRun } from "@/routes/backoffice/automations/script-view/workflow-run-presentation";
import {
  automationWorkflowRunsFromRecords,
  codemodeRunProgram,
  type WorkflowRunRecordSelector,
} from "@/routes/backoffice/automations/script-view/workflow-run-records";
import type { OrchestrationForward } from "@/routes/backoffice/dashboard/orchestration-graph";

import { CODEMODE_WORKFLOW } from "../engine/codemode-invocation";
import { piAgentState } from "../event-projections";
import { forwardAcceptLetsIn, forwardNeedsAccept } from "../forward-accepts";
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

/** The scope's forward accepts, by name. */
function readForwardAccepts(reader: LofiSqliteReader): AutomationForwardAccept[] {
  const accept = automationFragmentSchema.tables.automation_forward_accept.columns;
  return reader
    .query({
      sql: `SELECT "id", "name", "enabled", "senders", "matcher", "description"
            FROM ${automationTable("automation_forward_accept")}
            ORDER BY "name", "id"`,
      params: [],
      columns: {
        id: "text",
        name: accept.name,
        enabled: accept.enabled,
        senders: accept.senders,
        matcher: accept.matcher,
        description: accept.description,
      },
    })
    .map(({ senders, ...row }) => ({ ...row, from: senders }));
}

/**
 * The events forwarded into `ownerScope` since `since`, newest first, each with what lets it in.
 * Matching runs here so the page gets no payloads, and against today's accepts, which may differ
 * from those that let it in when it arrived.
 */
function readRecentForwards(
  reader: LofiSqliteReader,
  {
    since,
    ownerScope,
    accepts,
  }: {
    since: number;
    ownerScope: BackofficeContextScope;
    accepts: readonly AutomationForwardAccept[];
  },
): OrchestrationForward[] {
  const event = automationFragmentSchema.tables.automation_event.columns;
  const rows = reader.query({
    sql: `SELECT "id", "scope", "scopeRestriction", "source", "eventType", "occurredAt", "payload",
            "actors", "subject", "causation"
          FROM ${automationTable("automation_event")}
          WHERE "occurredAt" >= ? AND "causation" ->> '$.kind' = 'forward'
          ORDER BY "occurredAt" DESC, "id" DESC`,
    params: [since],
    columns: {
      id: "text",
      scope: event.scope,
      scopeRestriction: event.scopeRestriction,
      source: event.source,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: event.payload,
      actors: event.actors,
      subject: event.subject,
      causation: event.causation,
    },
  });
  return rows.map((row) => {
    // Only the automations fragment writes events, and the query keeps forwarded ones.
    const forwarded = { ...row, occurredAt: row.occurredAt.toISOString() } as AutomationEvent & {
      causation: Extract<AutomationEventCausation, { kind: "forward" }>;
    };
    const { from } = forwarded.causation;
    return {
      eventId: forwarded.id,
      source: forwarded.source,
      eventType: forwarded.eventType,
      occurredAt: forwarded.occurredAt,
      from,
      admittedBy: forwardNeedsAccept(from.scope, ownerScope)
        ? {
            kind: "accepts",
            acceptIds: accepts
              .filter((accept) => forwardAcceptLetsIn(accept, forwarded, from.scope))
              .map((accept) => accept.id),
          }
        : { kind: "trusted" },
    };
  });
}

/**
 * What the orchestration graph draws besides its records: the routes, the source and type of every
 * event that occurred since `since`, in epoch milliseconds, once per event so the graph can count
 * them, and where other scopes forward into `ownerScope`: its accepts, and what they forwarded
 * since `since`.
 */
export function readOrchestrationGraphInputs(
  reader: LofiSqliteReader,
  { since, ownerScope }: { since: number; ownerScope: BackofficeContextScope },
) {
  const forwardAccepts = readForwardAccepts(reader);
  return {
    routes: readAutomationRoutes(reader),
    forwardAccepts,
    recentForwards: readRecentForwards(reader, { since, ownerScope, accepts: forwardAccepts }),
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

/**
 * Where the scope's routes forwarded events since `since`, once per route and target scope: the
 * targets their templates rendered, which the routes alone do not name.
 */
export function readRecentForwardDeliveries(
  reader: LofiSqliteReader,
  { since }: { since: number },
): { routeId: string; scope: BackofficeContextScope }[] {
  const dispatch = automationFragmentSchema.tables.automation_route_dispatch.columns;
  const rows = reader.query({
    sql: `SELECT "routeId", "outcome"
          FROM ${automationTable("automation_route_dispatch")}
          WHERE "dispatchedAt" >= ? AND "outcome" ->> '$.kind' = 'event_forwarded'`,
    params: [since],
    columns: { routeId: dispatch.routeId, outcome: dispatch.outcome },
  });
  const deliveries = new Map<string, { routeId: string; scope: BackofficeContextScope }>();
  for (const { routeId, outcome } of rows) {
    // The query keeps forwarding outcomes, which name the scope they delivered to.
    const { scope } = outcome as Extract<
      AutomationRouteDispatchOutcome,
      { kind: "event_forwarded" }
    >;
    deliveries.set(JSON.stringify([routeId, scope]), { routeId, scope });
  }
  return [...deliveries.values()];
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

/**
 * Each workflow script's source as it last ran, by path: what a run keeps of the script it ran.
 * Scripts that never ran are not here.
 */
export function readLatestWorkflowPrograms(
  reader: LofiSqliteReader,
): { filename: string; code: string }[] {
  const instance = workflowsSchema.tables.workflow_instance.columns;
  // With max(), SQLite takes the other columns from the row holding the maximum.
  const rows = reader.query({
    sql: `SELECT "params" ->> '$.program.filename' AS "filename", "params", max("createdAt")
          FROM ${workflowTable("workflow_instance")}
          WHERE "workflowName" = ? AND "params" ->> '$.program.filename' IS NOT NULL
          GROUP BY "filename"
          ORDER BY "filename"`,
    params: [CODEMODE_WORKFLOW],
    columns: { params: instance.params },
  });
  return rows.flatMap(({ params }) => {
    const program = codemodeRunProgram(params);
    return program ? [program] : [];
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

/**
 * The scope's agents: built-in agents, and those their events define. The most recently active
 * come first; agents without activity keep built-in agents first, then go by name.
 */
export function readPiAgents(reader: LofiSqliteReader): PiAgentRecord[] {
  const agent = automationFragmentSchema.tables.pi_agent.columns;
  const rows = reader.query({
    sql: `SELECT "id" AS "agentName", "latestKind", "latestAt", "definition", "definitionAt",
            "definitionEventId", "paused", "pauseAt", "running", "queued", "steering"
          FROM ${automationTable("pi_agent")}`,
    params: [],
    columns: {
      agentName: "text",
      latestKind: agent.latestKind,
      latestAt: agent.latestAt,
      definition: agent.definition,
      definitionAt: agent.definitionAt,
      definitionEventId: agent.definitionEventId,
      paused: agent.paused,
      pauseAt: agent.pauseAt,
      running: agent.running,
      queued: agent.queued,
      steering: agent.steering,
    },
  });
  const states = new Map(rows.map(({ agentName, ...row }) => [agentName, piAgentState(row)]));
  const names = new Set([
    ...BUILT_IN_PI_AGENT_DEFINITIONS.map(({ agentName }) => agentName),
    ...states.keys(),
  ]);
  return [...names]
    .flatMap((agentName) => piAgentRecord(agentName, states.get(agentName) ?? null) ?? [])
    .sort(
      (left, right) =>
        (right.latestAt?.getTime() ?? -Infinity) - (left.latestAt?.getTime() ?? -Infinity) ||
        Number(right.builtIn) - Number(left.builtIn) ||
        (left.agentName < right.agentName ? -1 : left.agentName > right.agentName ? 1 : 0),
    );
}

const TURN_ENDED_EVENT_TYPES = [
  PI_TURN_AUTOMATION_EVENTS.completed,
  PI_TURN_AUTOMATION_EVENTS.aborted,
  PI_TURN_AUTOMATION_EVENTS.failed,
].map(({ eventType }) => eventType);

/** The turns agents ended since `since`, by the events that ended them. */
export function readPiAgentTurns(reader: LofiSqliteReader, since: Date): PiAgentTurnRecord[] {
  return readEventsOfTypes(reader, {
    source: PI_AUTOMATION_SOURCE,
    eventTypes: TURN_ENDED_EVENT_TYPES,
    since: since.getTime(),
  }).flatMap((event) => piAgentTurnEndedBy(event, readPiAgentEvent(event)) ?? []);
}

/**
 * The source's events of the types, oldest first, as stored. Of events in the same instant, the
 * one stored first comes first.
 */
function readEventsOfTypes(
  reader: LofiSqliteReader,
  { source, eventTypes, since }: { source: string; eventTypes: string[]; since: number },
) {
  const event = automationFragmentSchema.tables.automation_event;
  return reader.query({
    sql: `SELECT "id", "source", "eventType", "payload", "subject", "occurredAt"
          FROM ${automationTable("automation_event")}
          WHERE "source" = ? AND "eventType" IN (${eventTypes.map(() => "?").join(", ")})
            AND "occurredAt" >= ?
          ORDER BY "occurredAt", "${event.getInternalIdColumn().name}"`,
    params: [source, ...eventTypes, since],
    columns: {
      id: "text",
      source: event.columns.source,
      eventType: event.columns.eventType,
      payload: event.columns.payload,
      subject: event.columns.subject,
      occurredAt: event.columns.occurredAt,
    },
  });
}

/** Every connection, disconnected ones too, by service and then connection ID. */
export function readIntegrationConnections(
  reader: LofiSqliteReader,
): IntegrationConnectionRecord[] {
  const state = automationFragmentSchema.tables.automation_event_state.columns;
  const eventTypes = integrationConnectionEvents.map(({ eventType }) => eventType);
  const states = reader.query({
    sql: `SELECT "eventType", "eventId", "payload", "occurredAt", "storedAt"
          FROM ${automationTable("automation_event_state")}
          WHERE "source" = ? AND "eventType" IN (${eventTypes.map(() => "?").join(", ")})`,
    params: [INTEGRATIONS_EVENT_SOURCE, ...eventTypes],
    columns: {
      eventType: state.eventType,
      eventId: state.eventId,
      payload: state.payload,
      occurredAt: state.occurredAt,
      storedAt: state.storedAt,
    },
  });
  // Only connection events of these types, which name their connection, keep these states.
  return integrationConnectionsOfStates(states as IntegrationConnectionEventState[]);
}

/**
 * The state changes a connection's events reported, newest first. Of changes made in the same
 * instant, the first applied comes first, as it is the one `integrationConnectionsOfStates` keeps.
 */
export function readIntegrationConnectionHistory(
  reader: LofiSqliteReader,
  { connectionId }: { connectionId: string },
): IntegrationConnectionStateChange[] {
  const changes = readEventsOfTypes(reader, {
    source: INTEGRATIONS_EVENT_SOURCE,
    eventTypes: integrationConnectionEvents.map(({ eventType }) => eventType),
    since: 0,
  })
    .flatMap((event) => readIntegrationConnectionStateChange(event) ?? [])
    .filter((change) => change.connectionId === connectionId);
  return changes.sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
}

/** The connections that are not disconnected, by service and then connection ID. */
export function readCurrentIntegrationConnections(
  reader: LofiSqliteReader,
): IntegrationConnectionRecord[] {
  return readIntegrationConnections(reader).filter(({ state }) => state !== "disconnected");
}
