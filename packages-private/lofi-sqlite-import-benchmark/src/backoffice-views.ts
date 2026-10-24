import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

import {
  defineLocalProjection,
  type AnyLofiLocalProjection,
  type LofiMutationMatcher,
  type LofiSchemaRegistration,
} from "@fragno-dev/lofi";

import { automationFragmentSchema } from "../../../apps/backoffice/app/fragno/automation/schema";
import { BUILT_IN_PI_AGENT_DEFINITIONS } from "../../../apps/backoffice/app/fragno/pi/agent/agent-definitions";
import { formatPiAgentName } from "../../../apps/backoffice/app/fragno/pi/agent/pi-agent-name";
import {
  describeIntegrationConnectionKind,
  integrationConnectionName,
  readIntegrationConnectionStateChange,
  readPiAgentEvent,
  type IntegrationConnectionKind,
  type IntegrationConnectionLabel,
  type IntegrationConnectionStateChange,
  type PiAgentActivityKind,
  type PiAgentEvent,
} from "./backoffice-events";

// Backoffice derives these views in memory with `createDerivedCollection`, recomputing them from
// every source event. Here projections fold each outbox entry's events into stored rows instead.

const jsonColumn = <T>() => column("json") as Column<"json", T, T>;

/** When an event happened; events of the same instant are ordered by when they were stored. */
type EventOrder = { occurredAt: number; createdAt: number };

/**
 * What an agent's events record, kept between entries. Request IDs whose start and end, or whose
 * queueing and dequeueing, have both been seen are dropped, since they no longer change the agent.
 */
type PiAgentFold = {
  latest: EventOrder & { kind: PiAgentActivityKind };
  definition: (EventOrder & { definition: PiAgentDefinition | null }) | null;
  pause: (EventOrder & { paused: boolean }) | null;
  started: string[];
  ended: string[];
  waiting: Array<{ requestId: string; steer: boolean }>;
  dequeued: string[];
};

export const backofficeViewsSchema = schema("backoffice_views", (s) =>
  s
    .addTable("pi_agent_turn", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("agentName", column("string"))
        .addColumn("outcome", column("string"))
        .addColumn("endedAt", column("timestamp"))
        .createIndex("idx_pi_agent_turn_agentName_endedAt", ["agentName", "endedAt"]),
    )
    // Keyed by connection ID. `labelAt` is when the label's event happened.
    .addTable("integration_connection", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("service", column("string"))
        .addColumn("kind", column("string"))
        .addColumn("state", column("string"))
        .addColumn("name", column("string").nullable())
        .addColumn("authMethod", column("string").nullable())
        .addColumn("eventId", column("string"))
        .addColumn("changedAt", column("timestamp"))
        .addColumn("labelAt", column("timestamp").nullable())
        .addColumn("displayName", column("string"))
        .addColumn("kindLabel", column("string")),
    )
    // Keyed by agent name. Every agent with events has a row; Backoffice lists those with a
    // definition, and built-in agents whether or not they have events.
    .addTable("pi_agent", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("definition", jsonColumn<PiAgentDefinition>().nullable())
        .addColumn("builtIn", column("bool"))
        .addColumn("latestKind", column("string"))
        .addColumn("latestAt", column("timestamp"))
        .addColumn("answering", column("bool"))
        .addColumn("queued", column("integer"))
        .addColumn("steering", column("integer"))
        .addColumn("paused", column("bool"))
        .addColumn("displayName", column("string"))
        .addColumn("activity", column("string"))
        .addColumn("fold", jsonColumn<PiAgentFold>()),
    ),
);

const piAgentTurns = defineLocalProjection({
  name: "pi-agent-turns",
  mutate: ({ match, tx }) => {
    const views = tx.forSchema(backofficeViewsSchema);
    for (const { event, order } of createdEvents(match)) {
      const read = readPiAgentEvent(event);
      if (read?.kind === "answered" || read?.kind === "cut-off" || read?.kind === "failed") {
        views.create("pi_agent_turn", {
          id: event.id,
          agentName: read.agentName,
          outcome: read.kind,
          endedAt: new Date(order.occurredAt),
        });
      }
    }
  },
});

const integrationConnections = defineLocalProjection({
  name: "integration-connections",
  retrieve: ({ match, read }) => {
    const changes = createdEvents(match).flatMap(({ event, order }) => {
      const change = readIntegrationConnectionStateChange(event);
      return change ? [{ ...change, eventId: event.id, occurredAt: order.occurredAt }] : [];
    });
    return changes.length === 0
      ? undefined
      : read.getEach(
          groupBy(changes, (change) => change.connectionId),
          backofficeViewsSchema,
          "integration_connection",
          ({ key }) => key,
        );
  },
  mutate: ({ retrieved, tx }) => {
    const views = tx.forSchema(backofficeViewsSchema);
    for (const { item, row } of retrieved) {
      const stored: IntegrationConnection | null = row
        ? {
            service: row.service,
            kind: row.kind as IntegrationConnectionKind,
            state: row.state as IntegrationConnection["state"],
            label:
              row.name === null
                ? null
                : {
                    name: row.name,
                    authMethod: row.authMethod as IntegrationConnectionLabel["authMethod"],
                  },
            eventId: row.eventId,
            changedAt: row.changedAt.getTime(),
            labelAt: row.labelAt?.getTime() ?? null,
          }
        : null;
      const connection = item.values.reduce(applyConnectionChange, stored)!;
      const name = connection.label?.name ?? null;
      views.create("integration_connection", {
        id: item.key,
        service: connection.service,
        kind: connection.kind,
        state: connection.state,
        name,
        authMethod: connection.label?.authMethod ?? null,
        eventId: connection.eventId,
        changedAt: new Date(connection.changedAt),
        labelAt: connection.labelAt === null ? null : new Date(connection.labelAt),
        displayName: integrationConnectionName({ ...connection, connectionId: item.key, name }),
        kindLabel: describeIntegrationConnectionKind(connection),
      });
    }
  },
});

type IntegrationConnection = Omit<IntegrationConnectionStateChange, "connectionId"> & {
  eventId: string;
  changedAt: number;
  labelAt: number | null;
};

/**
 * A connection's latest change is its current state, labeled by its latest labeled change:
 * disconnections carry no label, so a removed connection keeps the name it had. Of changes made in
 * the same instant, the first applied wins, as in Backoffice's stable newest-first sort.
 */
function applyConnectionChange(
  current: IntegrationConnection | null,
  change: IntegrationConnectionStateChange & { eventId: string; occurredAt: number },
): IntegrationConnection {
  const isLatest = current === null || change.occurredAt > current.changedAt;
  const latest = isLatest
    ? {
        service: change.service,
        kind: change.kind,
        state: change.state,
        eventId: change.eventId,
        changedAt: change.occurredAt,
      }
    : current;
  const relabels =
    change.label !== null &&
    (current?.labelAt === null || current === null || change.occurredAt > current.labelAt);
  return {
    ...latest,
    label: relabels ? change.label : (current?.label ?? null),
    labelAt: relabels ? change.occurredAt : (current?.labelAt ?? null),
  };
}

const piAgents = defineLocalProjection({
  name: "pi-agents",
  retrieve: ({ match, read }) => {
    const events = createdEvents(match).flatMap(({ event, order }) => {
      const read = readPiAgentEvent(event);
      return read ? [{ read, order }] : [];
    });
    return events.length === 0
      ? undefined
      : read.getEach(
          groupBy(events, ({ read }) => read.agentName),
          backofficeViewsSchema,
          "pi_agent",
          ({ key }) => key,
        );
  },
  mutate: ({ retrieved, tx }) => {
    const views = tx.forSchema(backofficeViewsSchema);
    for (const { item, row } of retrieved) {
      const fold = item.values.reduce<PiAgentFold | null>(
        (current, { read, order }) => foldPiAgentEvent(current, read, order),
        row?.fold ?? null,
      )!;
      const builtIn =
        BUILT_IN_PI_AGENT_DEFINITIONS.find(({ agentName }) => agentName === item.key) ?? null;
      const answering = fold.started.length > 0;
      const paused = fold.pause?.paused ?? false;
      views.create("pi_agent", {
        id: item.key,
        definition: builtIn ?? fold.definition?.definition ?? null,
        builtIn: builtIn !== null,
        latestKind: fold.latest.kind,
        latestAt: new Date(fold.latest.occurredAt),
        answering,
        queued: fold.waiting.filter(({ steer }) => !steer).length,
        steering: fold.waiting.filter(({ steer }) => steer).length,
        paused,
        displayName: formatPiAgentName(item.key),
        activity: answering ? "Answering" : paused ? "Stopped" : activityLabels[fold.latest.kind],
        fold,
      });
    }
  },
});

/** Requests are matched by ID, not order, so a turn whose start was stored after its end has ended. */
function foldPiAgentEvent(
  current: PiAgentFold | null,
  read: PiAgentEvent,
  order: EventOrder,
): PiAgentFold {
  const fold: PiAgentFold = current
    ? {
        ...current,
        latest: isLater(order, current.latest) ? { ...order, kind: read.kind } : current.latest,
      }
    : {
        latest: { ...order, kind: read.kind },
        definition: null,
        pause: null,
        started: [],
        ended: [],
        waiting: [],
        dequeued: [],
      };
  const started = new Set(fold.started);
  const ended = new Set(fold.ended);
  const waiting = new Map(fold.waiting.map(({ requestId, steer }) => [requestId, steer]));
  const dequeued = new Set(fold.dequeued);

  switch (read.kind) {
    case "created":
    case "updated":
    case "deleted":
      if (isLater(order, fold.definition)) {
        fold.definition = {
          ...order,
          definition: read.kind === "deleted" ? null : read.definition,
        };
      }
      break;
    case "stopped":
    case "resumed":
      if (isLater(order, fold.pause)) {
        fold.pause = { ...order, paused: read.kind === "stopped" };
      }
      break;
    case "started":
      started.add(read.requestId);
      dequeued.add(read.requestId);
      break;
    case "answered":
    case "cut-off":
    case "failed":
      ended.add(read.requestId);
      // A steer its turn's stop cut off before Pi placed it ends without starting.
      dequeued.add(read.requestId);
      break;
    case "queued":
      waiting.set(read.requestId, read.steer);
      break;
    case "dispatched":
    case "dropped":
      dequeued.add(read.requestId);
      break;
  }

  for (const requestId of started) {
    if (ended.delete(requestId)) {
      started.delete(requestId);
    }
  }
  for (const requestId of waiting.keys()) {
    if (dequeued.delete(requestId)) {
      waiting.delete(requestId);
    }
  }
  return {
    ...fold,
    started: [...started],
    ended: [...ended],
    waiting: [...waiting].map(([requestId, steer]) => ({ requestId, steer })),
    dequeued: [...dequeued],
  };
}

function isLater(event: EventOrder, than: EventOrder | null): boolean {
  return (
    than === null ||
    event.occurredAt > than.occurredAt ||
    (event.occurredAt === than.occurredAt && event.createdAt > than.createdAt)
  );
}

const activityLabels: Record<PiAgentActivityKind, string> = {
  started: "Started a turn",
  answered: "Answered",
  "cut-off": "Turn cut off",
  failed: "Turn failed",
  queued: "Work queued",
  dispatched: "Took queued work",
  dropped: "Dropped queued work",
  created: "Defined",
  updated: "Definition updated",
  deleted: "Deleted",
  stopped: "Stopped",
  resumed: "Resumed",
};

/** The automation events an entry stores. Events are never changed in ways these views read. */
function createdEvents(match: LofiMutationMatcher) {
  return match.all(automationFragmentSchema, "automation_event", "create").map((mutation) => ({
    event: {
      id: mutation.externalId,
      source: mutation.values.source,
      eventType: mutation.values.eventType,
      payload: mutation.values.payload,
      subject: mutation.values.subject ?? null,
    },
    // The replica decodes outbox dates and resolves `now()` before projections run.
    order: {
      occurredAt: (mutation.values.occurredAt as Date).getTime(),
      createdAt: (mutation.values.createdAt as Date).getTime(),
    },
  }));
}

/** Groups in first-seen order, keeping each group's values in their original order. */
function groupBy<T>(values: T[], key: (value: T) => string): Array<{ key: string; values: T[] }> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const group = groups.get(key(value));
    if (group) {
      group.push(value);
    } else {
      groups.set(key(value), [value]);
    }
  }
  return [...groups].map(([groupKey, groupValues]) => ({ key: groupKey, values: groupValues }));
}

/** Backoffice's views, as a local schema and the projections that maintain it. */
export const backofficeViews: {
  localSchemas: LofiSchemaRegistration[];
  projections: AnyLofiLocalProjection[];
} = {
  localSchemas: [{ schema: backofficeViewsSchema }],
  projections: [piAgentTurns, integrationConnections, piAgents],
};
