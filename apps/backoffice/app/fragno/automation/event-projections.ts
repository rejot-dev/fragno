import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import type { FragnoId } from "@fragno-dev/db/schema";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import {
  PI_AGENT_AUTOMATION_EVENTS,
  PI_AUTOMATION_SOURCE,
  PI_QUEUE_AUTOMATION_EVENTS,
  PI_TURN_AUTOMATION_EVENTS,
  readPiAgentEvent,
  type PiAgentActivityKind,
  type PiAgentEvent,
} from "@/fragno/backoffice-capabilities/capabilities/pi";
import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";
import {
  applyPiAgentEvent,
  piAgentEventRequestId,
  piAgentRequestKey,
  piAgentTurnEndedBy,
  type PiAgentRequestState,
  type PiAgentState,
  type PiAgentTurnRecord,
} from "@/fragno/pi/agent/pi-agent-records";
import {
  applyIntegrationConnectionChange,
  integrationConnectionRecord,
  readIntegrationConnectionStateChange,
  type IntegrationConnectionFold,
  type IntegrationConnectionKind,
  type IntegrationConnectionRecord,
  type IntegrationConnectionStateChange,
} from "@/fragno/runtime-tools/families/integrations/integration-connections";
import {
  INTEGRATIONS_EVENT_SOURCE,
  integrationConnectionEvents,
  type IntegrationConnectionLabel,
} from "@/fragno/runtime-tools/families/integrations/integration-events";

import type { AutomationHookUnitOfWork } from "./internal-hooks";
import { automationFragmentSchema } from "./schema";

type EventProjectionServiceContext = DatabaseServiceContext<Record<string, never>>;

/** An event as it is stored, which is all the fold reads of it. */
type StoredEvent = {
  id: string;
  source: string;
  eventType: string;
  payload: unknown;
  subject: unknown;
  occurredAt: Date;
};

/**
 * Every event type the fold reads, in the order a replay folds them: an agent's events as its
 * lifecycle runs, so of events in the same instant the later step wins, which is usually the one
 * stored later.
 */
export const FOLDED_EVENT_TYPES: readonly { source: string; eventType: string }[] = [
  ...[
    PI_AGENT_AUTOMATION_EVENTS.created,
    PI_AGENT_AUTOMATION_EVENTS.updated,
    PI_AGENT_AUTOMATION_EVENTS.deleted,
    PI_AGENT_AUTOMATION_EVENTS.stopped,
    PI_AGENT_AUTOMATION_EVENTS.resumed,
    PI_QUEUE_AUTOMATION_EVENTS.added,
    PI_QUEUE_AUTOMATION_EVENTS.dispatched,
    PI_QUEUE_AUTOMATION_EVENTS.dropped,
    PI_TURN_AUTOMATION_EVENTS.started,
    PI_TURN_AUTOMATION_EVENTS.completed,
    PI_TURN_AUTOMATION_EVENTS.aborted,
    PI_TURN_AUTOMATION_EVENTS.failed,
  ].map(({ eventType }) => ({ source: PI_AUTOMATION_SOURCE, eventType })),
  ...integrationConnectionEvents.map(({ eventType }) => ({
    source: INTEGRATIONS_EVENT_SOURCE,
    eventType,
  })),
];

/** What a stored event records of an agent or a connection, read before its rows are. */
type ProjectedEvent =
  | {
      kind: "pi";
      id: string;
      occurredAt: Date;
      read: PiAgentEvent;
      requestKey: string | null;
      turn: PiAgentTurnRecord | null;
    }
  | { kind: "connection"; change: IntegrationConnectionStateChange }
  | { kind: "none" };

export function projectedEventOf(event: StoredEvent): ProjectedEvent {
  const read = readPiAgentEvent(event);
  if (read) {
    const requestId = piAgentEventRequestId(read);
    return {
      kind: "pi",
      id: event.id,
      occurredAt: event.occurredAt,
      read,
      requestKey: requestId === null ? null : piAgentRequestKey(read.agentName, requestId),
      turn: piAgentTurnEndedBy(event, read),
    };
  }
  const change = readIntegrationConnectionStateChange(event);
  return change ? { kind: "connection", change } : { kind: "none" };
}

/** The IDs of the rows the events change, by table; empty for the tables they leave alone. */
export function projectedEventKeys(events: readonly ProjectedEvent[]) {
  const keys = {
    agents: new Set<string>(),
    requests: new Set<string>(),
    turns: new Set<string>(),
    connections: new Set<string>(),
    changes: new Set<string>(),
  };
  for (const event of events) {
    if (event.kind === "pi") {
      keys.agents.add(event.read.agentName);
      if (event.requestKey !== null) {
        keys.requests.add(event.requestKey);
      }
      if (event.turn) {
        keys.turns.add(event.turn.id);
      }
    } else if (event.kind === "connection") {
      keys.connections.add(event.change.connectionId);
      keys.changes.add(event.change.eventId);
    }
  }
  return {
    agents: [...keys.agents],
    requests: [...keys.requests],
    turns: [...keys.turns],
    connections: [...keys.connections],
    changes: [...keys.changes],
  };
}

type PiAgentRow = {
  id: FragnoId;
  latestKind: string;
  latestAt: Date;
  definition: PiAgentDefinition | null;
  definitionAt: Date | null;
  definitionEventId: string | null;
  paused: boolean | null;
  pauseAt: Date | null;
  running: number;
  queued: number;
  steering: number;
};

type PiAgentRequestRow = PiAgentRequestState & { id: FragnoId };

type IntegrationConnectionRow = {
  id: FragnoId;
  service: string;
  kind: string;
  state: string;
  eventId: string;
  changedAt: Date;
  name: string | null;
  authMethod: string | null;
  labelAt: Date | null;
};

/** The rows `projectedEventKeys` names, as the transaction that folds the events read them. */
type ProjectedRows = {
  agentRows: readonly PiAgentRow[];
  requestRows: readonly PiAgentRequestRow[];
  turnRows: readonly { id: FragnoId }[];
  connectionRows: readonly IntegrationConnectionRow[];
  changeRows: readonly { id: FragnoId }[];
};

/**
 * Folds stored events, in order, into the rows they change, and writes each row once. Ingestion
 * folds each event as it stores it; the replay folds events stored before ingestion did, and those
 * stored since, again. Folding an event again changes nothing but ties: requests record what
 * happened to them, not how often, turns and changes are keyed by their event, and agents and
 * connections keep their latest changes by when they happened. Of an agent's changes in the same
 * instant the one folded last wins, and of a connection's the first, so the replay, which folds by
 * type, can settle such a tie unlike ingestion did. Events about one agent or connection can be
 * folded concurrently: updates check the row's version, and creating a row another transaction
 * created meanwhile retries, so the loser folds into the winner's row.
 */
export function foldProjectedEvents(
  uow: AutomationHookUnitOfWork,
  events: readonly ProjectedEvent[],
  rows: ProjectedRows,
) {
  const agents = new Map(rows.agentRows.map((row) => [row.id.externalId, piAgentState(row)]));
  const requests = new Map<string, PiAgentRequestState>(
    rows.requestRows.map(({ id, ...request }) => [id.externalId, request]),
  );
  const connections = new Map(
    rows.connectionRows.map((row) => [row.id.externalId, integrationConnectionFold(row)]),
  );
  const recorded = new Set([...rows.turnRows, ...rows.changeRows].map((row) => row.id.externalId));
  for (const event of events) {
    switch (event.kind) {
      case "pi": {
        const applied = applyPiAgentEvent(
          agents.get(event.read.agentName) ?? null,
          event.requestKey === null ? null : (requests.get(event.requestKey) ?? null),
          event.read,
          event,
        );
        agents.set(event.read.agentName, applied.agent);
        if (event.requestKey !== null && applied.request) {
          requests.set(event.requestKey, applied.request);
        }
        if (event.turn && !recorded.has(event.turn.id)) {
          recorded.add(event.turn.id);
          uow.create("pi_agent_turn", event.turn);
        }
        break;
      }
      case "connection": {
        const { change } = event;
        connections.set(
          change.connectionId,
          applyIntegrationConnectionChange(connections.get(change.connectionId) ?? null, change),
        );
        if (!recorded.has(change.eventId)) {
          recorded.add(change.eventId);
          uow.create("integration_connection_change", {
            id: change.eventId,
            connectionId: change.connectionId,
            service: change.service,
            kind: change.kind,
            state: change.state,
            label: change.label,
            occurredAt: change.occurredAt,
          });
        }
        break;
      }
      case "none":
        break;
    }
  }

  const agentRows = new Map(rows.agentRows.map((row) => [row.id.externalId, row]));
  for (const [agentName, agent] of agents) {
    const row = agentRows.get(agentName);
    if (row) {
      updateChangedColumns(uow, "pi_agent", row, piAgentColumns(agent));
    } else {
      uow.create(
        "pi_agent",
        { id: agentName, displayName: formatPiAgentName(agentName), ...piAgentColumns(agent) },
        { retryOnUniqueConflict: () => true },
      );
    }
  }
  const requestRows = new Map(rows.requestRows.map((row) => [row.id.externalId, row]));
  for (const [requestKey, request] of requests) {
    const row = requestRows.get(requestKey);
    if (row) {
      updateChangedColumns(uow, "pi_agent_request", row, request);
    } else {
      uow.create(
        "pi_agent_request",
        { id: requestKey, ...request },
        { retryOnUniqueConflict: () => true },
      );
    }
  }
  const connectionRows = new Map(rows.connectionRows.map((row) => [row.id.externalId, row]));
  for (const [connectionId, fold] of connections) {
    const row = connectionRows.get(connectionId);
    const connection = integrationConnectionColumns(fold);
    if (row) {
      updateChangedColumns(uow, "integration_connection", row, connection);
    } else {
      uow.create(
        "integration_connection",
        { id: connectionId, ...connection },
        { retryOnUniqueConflict: () => true },
      );
    }
  }
}

/**
 * Updates the row's columns whose value the event changed, and no others: the outbox replicates
 * every column an update sets, and most agent events change a count, not the definition. When
 * nothing changed, only checks the row's version: a concurrent change still retries the event, and
 * the outbox gets no entry.
 */
function updateChangedColumns(
  uow: AutomationHookUnitOfWork,
  table: "pi_agent" | "pi_agent_request" | "integration_connection",
  row: { id: FragnoId } & Record<string, unknown>,
  columns: Record<string, unknown>,
) {
  const changed = Object.fromEntries(
    Object.entries(columns).filter(([name, value]) => !sameColumnValue(row[name], value)),
  );
  if (Object.keys(changed).length === 0) {
    uow.check(table, row.id);
    return;
  }
  uow.update(table, row.id, (b) => b.set(changed as never).check());
}

function sameColumnValue(stored: unknown, value: unknown) {
  // Most events leave the definition as they read it, so its JSON need not be compared.
  if (stored === value) {
    return true;
  }
  if (stored instanceof Date && value instanceof Date) {
    return stored.getTime() === value.getTime();
  }
  // JSON columns; a reordered object reads as changed, which only writes it again.
  if (typeof stored === "object" && stored !== null) {
    return JSON.stringify(stored) === JSON.stringify(value);
  }
  return stored === value;
}

/** Only `projectStoredEvent` writes agent rows, from `PiAgentState`. */
export function piAgentState(row: Omit<PiAgentRow, "id">): PiAgentState {
  return {
    latest: { kind: row.latestKind as PiAgentActivityKind, occurredAt: row.latestAt },
    definition:
      row.definitionAt === null || row.definitionEventId === null
        ? null
        : {
            definition: row.definition,
            occurredAt: row.definitionAt,
            eventId: row.definitionEventId,
          },
    pause:
      row.paused === null || row.pauseAt === null
        ? null
        : { paused: row.paused, occurredAt: row.pauseAt },
    running: row.running,
    queued: row.queued,
    steering: row.steering,
  };
}

function piAgentColumns(agent: PiAgentState) {
  return {
    latestKind: agent.latest.kind,
    latestAt: agent.latest.occurredAt,
    definition: agent.definition?.definition ?? null,
    definitionAt: agent.definition?.occurredAt ?? null,
    definitionEventId: agent.definition?.eventId ?? null,
    paused: agent.pause?.paused ?? null,
    pauseAt: agent.pause?.occurredAt ?? null,
    running: agent.running,
    queued: agent.queued,
    steering: agent.steering,
  };
}

function integrationConnectionColumns(fold: IntegrationConnectionFold) {
  const record = integrationConnectionRecord(fold);
  return {
    service: record.service,
    kind: record.kind,
    state: record.state,
    eventId: record.eventId,
    changedAt: record.changedAt,
    name: record.name,
    authMethod: record.authMethod,
    labelAt: fold.labelAt,
    displayName: record.displayName,
    kindLabel: record.kindLabel,
  };
}

function integrationConnectionFold(row: IntegrationConnectionRow): IntegrationConnectionFold {
  // Only `projectStoredEvent` writes these rows, from `IntegrationConnectionFold`. Folding reads
  // when the latest change happened, not its own label.
  const label: IntegrationConnectionLabel | null =
    row.labelAt === null
      ? null
      : {
          name: row.name!,
          authMethod: row.authMethod as IntegrationConnectionLabel["authMethod"],
        };
  return {
    latest: {
      eventId: row.eventId,
      connectionId: row.id.externalId,
      service: row.service,
      kind: row.kind as IntegrationConnectionKind,
      state: row.state as IntegrationConnectionStateChange["state"],
      label,
      occurredAt: row.changedAt,
    },
    label,
    labelAt: row.labelAt,
  };
}

/** An agent's latest definition change; `definition` is null when it deleted the agent. */
export type RecordedPiAgentDefinition = {
  agentName: string;
  definition: PiAgentDefinition | null;
  /** The event that recorded the change. */
  eventId: string;
};

export const createEventProjectionServices = (
  defineService: <TService>(
    service: TService & ThisType<EventProjectionServiceContext>,
  ) => TService,
) =>
  defineService({
    /** Every agent a definition event recorded. A scope keeps few agents. */
    listRecordedPiAgentDefinitions() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) => uow.find("pi_agent", (b) => b.whereIndex("primary")))
        .transformRetrieve(([rows]) =>
          rows.flatMap(({ id, definition, definitionEventId }): RecordedPiAgentDefinition[] =>
            definitionEventId === null
              ? []
              : [{ agentName: id.externalId, definition, eventId: definitionEventId }],
          ),
        )
        .build();
    },
    /** Every connection, disconnected ones too. A scope keeps few connections. */
    listIntegrationConnections() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) => uow.find("integration_connection", (b) => b.whereIndex("primary")))
        .transformRetrieve(([rows]) =>
          rows.map(
            (row): IntegrationConnectionRecord =>
              integrationConnectionRecord(integrationConnectionFold(row)),
          ),
        )
        .build();
    },
  });
