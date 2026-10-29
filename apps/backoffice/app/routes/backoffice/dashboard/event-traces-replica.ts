import { column } from "@fragno-dev/db/schema";
import { lofiSqliteTableName, type LofiSqliteReader } from "@fragno-dev/lofi/sqlite";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import { automationFragmentSchema } from "@/fragno/automation/schema";

import {
  eventTraceDispatch,
  eventTraceRunIds,
  projectEventTraceSummaries,
  type EventTraceDelivery,
  type EventTraceDispatch,
  type EventTraceDispatchRow,
  type EventTraceEvent,
  type EventTraceRun,
  type EventTraceStep,
} from "./event-traces";

const automationTable = (name: keyof typeof automationFragmentSchema.tables) =>
  `"${lofiSqliteTableName({ schema: automationFragmentSchema }, name)}"`;
const workflowTable = (name: keyof typeof workflowsSchema.tables) =>
  `"${lofiSqliteTableName({ schema: workflowsSchema }, name)}"`;
const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

const event = automationFragmentSchema.tables.automation_event.columns;
const EVENT_COLUMNS = {
  id: "text",
  source: event.source,
  eventType: event.eventType,
  // NULL for an event type the scope's catalog does not define.
  label: column("string").nullable(),
  occurredAt: event.occurredAt,
  causation: event.causation,
  rootEventId: event.rootEventId,
  routesMatched: event.routesMatched,
} as const;
const EVENT_TABLE = automationTable("automation_event");
// Sources match case-insensitively, as the orchestration graph folds them.
const EVENT_SELECT = `"id", "source", "eventType",
  (SELECT "definition"."label" FROM ${automationTable("automation_event_definition")} AS "definition"
    WHERE lower("definition"."source") = lower(${EVENT_TABLE}."source")
      AND "definition"."eventType" = ${EVENT_TABLE}."eventType"
    LIMIT 1) AS "label",
  "occurredAt", "causation", "rootEventId", "routesMatched"`;

/** What a trace reads of its events. Only the events a view shows carry their payload. */
type EventRow = Omit<EventTraceEvent, "payload" | "subject">;

// Synchronized rows are written by the automations fragment, so their JSON columns and status
// strings hold the shapes it persists.
const withoutBody = (row: EventRow): EventTraceEvent => ({ ...row, payload: null, subject: null });

function readDispatches(
  reader: LofiSqliteReader,
  rootEventIds: readonly string[],
): EventTraceDispatch[] {
  if (rootEventIds.length === 0) {
    return [];
  }
  const dispatch = automationFragmentSchema.tables.automation_route_dispatch.columns;
  const rows = reader.query({
    sql: `SELECT "id", "eventId", "rootEventId", "routeId", "routeName", "status", "outcome",
            "failedAttempts", "error", "dispatchedAt"
          FROM ${automationTable("automation_route_dispatch")}
          WHERE "rootEventId" IN (${placeholders(rootEventIds.length)})`,
    params: [...rootEventIds],
    columns: {
      id: "text",
      eventId: dispatch.eventId,
      rootEventId: dispatch.rootEventId,
      routeId: dispatch.routeId,
      routeName: dispatch.routeName,
      status: dispatch.status,
      outcome: dispatch.outcome,
      failedAttempts: dispatch.failedAttempts,
      error: dispatch.error,
      dispatchedAt: dispatch.dispatchedAt,
    },
  });
  return (rows as EventTraceDispatchRow[]).map(eventTraceDispatch);
}

/** The runs the dispatches started or sent events to, which a trace names its routes by. */
function readDispatchedRuns(
  reader: LofiSqliteReader,
  dispatches: readonly EventTraceDispatch[],
): EventTraceRun[] {
  const keys = new Map<string, [string, string]>();
  for (const { state } of dispatches) {
    if (
      state.status === "completed" &&
      (state.outcome.kind === "workflow_started" || state.outcome.kind === "workflow_event_sent")
    ) {
      const { workflowName, instanceId } = state.outcome;
      keys.set(JSON.stringify([workflowName, instanceId]), [workflowName, instanceId]);
    }
  }
  if (keys.size === 0) {
    return [];
  }
  const instance = workflowsSchema.tables.workflow_instance.columns;
  const rows = reader.query({
    sql: `SELECT "id", "workflowName", "instanceId", "remoteWorkflowName", "status",
            "errorMessage", "createdAt", "startedAt", "completedAt"
          FROM ${workflowTable("workflow_instance")}
          WHERE ("workflowName", "instanceId") IN (VALUES ${[...keys.values()]
            .map(() => "(?, ?)")
            .join(", ")})`,
    params: [...keys.values()].flat(),
    columns: {
      id: "text",
      workflowName: instance.workflowName,
      instanceId: instance.instanceId,
      remoteWorkflowName: instance.remoteWorkflowName,
      status: instance.status,
      errorMessage: instance.errorMessage,
      createdAt: instance.createdAt,
      startedAt: instance.startedAt,
      completedAt: instance.completedAt,
    },
  });
  return rows as EventTraceRun[];
}

/**
 * Which origins a list reads: all of them, or only those something acted on. Origins nothing acted
 * on can far outnumber the rest, so a list of what automations did leaves them out before it
 * limits, or they would push out what it shows.
 */
type EventTraceOrigins = "all" | "acted-on";

// Mirrors `traceOutcome`'s "unhandled": routes have matched it, yet it caused no dispatch and no
// event.
const ACTED_ON_ORIGIN = `("routesMatched" = 0
  OR EXISTS (SELECT 1 FROM ${automationTable("automation_route_dispatch")} AS "dispatch"
    WHERE "dispatch"."rootEventId" = ${EVENT_TABLE}."id")
  OR EXISTS (SELECT 1 FROM ${EVENT_TABLE} AS "derived"
    WHERE "derived"."rootEventId" = ${EVENT_TABLE}."id" AND "derived"."id" <> "derived"."rootEventId"))`;

/**
 * The newest `limit` origins' summaries, as the Activity list shows them. They are projected where
 * they are read, so the origins' payloads, which can be whole webhook bodies, stay in the worker.
 */
export function readEventTraceSummaries(
  reader: LofiSqliteReader,
  { limit, origins }: { limit: number; origins: EventTraceOrigins },
) {
  return projectEventTraceSummaries({ ...readEventTraceList(reader, { limit, origins }), limit });
}

/**
 * What `projectEventTraceSummaries` needs for the newest `limit` origins: the origins, with the
 * payload their headline comes from, the events they caused, their dispatches, and the runs those
 * started or sent events to. Origins that tie on time come newest ID first.
 */
function readEventTraceList(
  reader: LofiSqliteReader,
  { limit, origins: which }: { limit: number; origins: EventTraceOrigins },
) {
  const origins = reader.query({
    sql: `SELECT ${EVENT_SELECT}, "payload"
          FROM ${EVENT_TABLE}
          WHERE ("rootEventId" IS NULL OR "rootEventId" = "id")
            ${which === "acted-on" ? `AND ${ACTED_ON_ORIGIN}` : ""}
          ORDER BY "occurredAt" DESC, "id" DESC
          LIMIT ?`,
    params: [limit],
    columns: { ...EVENT_COLUMNS, payload: event.payload },
  });
  const originIds = origins.map(({ id }) => id);
  const derived =
    originIds.length === 0
      ? []
      : reader.query({
          sql: `SELECT ${EVENT_SELECT}
                FROM ${EVENT_TABLE}
                WHERE "rootEventId" IN (${placeholders(originIds.length)}) AND "id" <> "rootEventId"`,
          params: originIds,
          columns: EVENT_COLUMNS,
        });
  const dispatches = readDispatches(reader, originIds);
  const runs = readDispatchedRuns(reader, dispatches);
  const events: EventTraceEvent[] = [
    ...origins.map((origin) => ({ ...origin, subject: null }) as EventTraceEvent),
    ...(derived as EventRow[]).map(withoutBody),
  ];
  return { events, dispatches, runs };
}

/**
 * What `projectEventTrace` needs for one origin: its events in full, its dispatches, the runs they
 * started or sent events to, and the steps and workflow events of those runs.
 */
export function readEventTrace(reader: LofiSqliteReader, { rootEventId }: { rootEventId: string }) {
  const events = reader.query({
    sql: `SELECT ${EVENT_SELECT}, "payload", "subject"
            FROM ${EVENT_TABLE}
            WHERE "id" = ? OR "rootEventId" = ?`,
    params: [rootEventId, rootEventId],
    columns: { ...EVENT_COLUMNS, payload: event.payload, subject: event.subject },
  });
  const dispatches = readDispatches(reader, [rootEventId]);
  const runs = readDispatchedRuns(reader, dispatches);
  const runIds = eventTraceRunIds({ rootEventId, dispatches, runs });
  if (runIds.length === 0) {
    return {
      events: events as EventTraceEvent[],
      dispatches,
      runs,
      steps: [] as EventTraceStep[],
      deliveries: [] as EventTraceDelivery[],
    };
  }

  const { workflow_instance, workflow_step, workflow_event } = workflowsSchema.tables;
  const step = workflow_step.columns;
  const delivery = workflow_event.columns;
  // Rows reference a run by its internal ID; traces name runs by their external one.
  const internalId = `"${workflow_instance.getInternalIdColumn().name}"`;
  const runsOfTrace = `JOIN ${workflowTable("workflow_instance")} AS "run"
    ON "run".${internalId} = "row"."instanceRef"
    WHERE "run"."id" IN (${placeholders(runIds.length)})`;
  const steps = reader.query({
    sql: `SELECT "row"."id", "run"."id" AS "instanceRef", "row"."stepKey", "row"."parentStepKey",
              "row"."name", "row"."type", "row"."status", "row"."attempts", "row"."waitEventType",
              "row"."errorMessage", "row"."createdAt", "row"."updatedAt"
            FROM ${workflowTable("workflow_step")} AS "row" ${runsOfTrace}`,
    params: runIds,
    columns: {
      id: "text",
      instanceRef: "text",
      stepKey: step.stepKey,
      parentStepKey: step.parentStepKey,
      name: step.name,
      type: step.type,
      status: step.status,
      attempts: step.attempts,
      waitEventType: step.waitEventType,
      errorMessage: step.errorMessage,
      createdAt: step.createdAt,
      updatedAt: step.updatedAt,
    },
  });
  const deliveries = reader.query({
    sql: `SELECT "row"."id", "run"."id" AS "instanceRef", "row"."type", "row"."createdAt",
              "row"."deliveredAt", "row"."consumedByStepKey"
            FROM ${workflowTable("workflow_event")} AS "row" ${runsOfTrace}`,
    params: runIds,
    columns: {
      id: "text",
      instanceRef: "text",
      type: delivery.type,
      createdAt: delivery.createdAt,
      deliveredAt: delivery.deliveredAt,
      consumedByStepKey: delivery.consumedByStepKey,
    },
  });
  return {
    events: events as EventTraceEvent[],
    dispatches,
    runs,
    steps: steps as EventTraceStep[],
    deliveries: deliveries as EventTraceDelivery[],
  };
}
