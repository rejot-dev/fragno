import { lofiSqliteTableName, type LofiSqliteReplica } from "@fragno-dev/lofi/sqlite";
import { workflowsSchema } from "@fragno-dev/workflows/schema";

import { automationFragmentSchema } from "@/fragno/automation/schema";

import {
  eventTraceDispatch,
  eventTraceRunIds,
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
  occurredAt: event.occurredAt,
  causation: event.causation,
  rootEventId: event.rootEventId,
  routesMatched: event.routesMatched,
} as const;
const EVENT_SELECT = `"id", "source", "eventType", "occurredAt", "causation", "rootEventId",
  "routesMatched"`;

/** What a trace reads of its events. Only the events a view shows carry their payload. */
type EventRow = Omit<EventTraceEvent, "payload" | "subject">;

// Synchronized rows are written by the automations fragment, so their JSON columns and status
// strings hold the shapes it persists.
const withoutBody = (row: EventRow): EventTraceEvent => ({ ...row, payload: null, subject: null });

async function readDispatches(
  replica: LofiSqliteReplica,
  rootEventIds: readonly string[],
): Promise<EventTraceDispatch[]> {
  if (rootEventIds.length === 0) {
    return [];
  }
  const dispatch = automationFragmentSchema.tables.automation_route_dispatch.columns;
  const rows = await replica.query({
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
async function readDispatchedRuns(
  replica: LofiSqliteReplica,
  dispatches: readonly EventTraceDispatch[],
): Promise<EventTraceRun[]> {
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
  const rows = await replica.query({
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
 * What `projectEventTraceSummaries` needs for the newest `limit` origins: the origins, with the
 * payload their headline comes from, the events they caused, their dispatches, and the runs those
 * started or sent events to. Origins that tie on time come newest ID first.
 */
export async function readEventTraceList(replica: LofiSqliteReplica, limit: number) {
  const origins = await replica.query({
    sql: `SELECT ${EVENT_SELECT}, "payload"
          FROM ${automationTable("automation_event")}
          WHERE "rootEventId" IS NULL OR "rootEventId" = "id"
          ORDER BY "occurredAt" DESC, "id" DESC
          LIMIT ?`,
    params: [limit],
    columns: { ...EVENT_COLUMNS, payload: event.payload },
  });
  const originIds = origins.map(({ id }) => id);
  const [derived, dispatches] = await Promise.all([
    originIds.length === 0
      ? []
      : replica.query({
          sql: `SELECT ${EVENT_SELECT}
                FROM ${automationTable("automation_event")}
                WHERE "rootEventId" IN (${placeholders(originIds.length)}) AND "id" <> "rootEventId"`,
          params: originIds,
          columns: EVENT_COLUMNS,
        }),
    readDispatches(replica, originIds),
  ]);
  const runs = await readDispatchedRuns(replica, dispatches);
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
export async function readEventTrace(replica: LofiSqliteReplica, rootEventId: string) {
  const [events, dispatches] = await Promise.all([
    replica.query({
      sql: `SELECT ${EVENT_SELECT}, "payload", "subject"
            FROM ${automationTable("automation_event")}
            WHERE "id" = ? OR "rootEventId" = ?`,
      params: [rootEventId, rootEventId],
      columns: { ...EVENT_COLUMNS, payload: event.payload, subject: event.subject },
    }),
    readDispatches(replica, [rootEventId]),
  ]);
  const runs = await readDispatchedRuns(replica, dispatches);
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
  const [steps, deliveries] = await Promise.all([
    replica.query({
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
    }),
    replica.query({
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
    }),
  ]);
  return {
    events: events as EventTraceEvent[],
    dispatches,
    runs,
    steps: steps as EventTraceStep[],
    deliveries: deliveries as EventTraceDelivery[],
  };
}
