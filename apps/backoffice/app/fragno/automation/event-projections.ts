import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import type { FragnoId } from "@fragno-dev/db/schema";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import {
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
import type { IntegrationConnectionLabel } from "@/fragno/runtime-tools/families/integrations/integration-events";

import type { AutomationHookUnitOfWork } from "./internal-hooks";
import { automationFragmentSchema } from "./schema";

type EventProjectionServiceContext = DatabaseServiceContext<Record<string, never>>;

/** What a stored event records of an agent or a connection, read before its rows are. */
export type EventProjection =
  | { kind: "pi"; read: PiAgentEvent; requestKey: string | null }
  | { kind: "connection"; change: IntegrationConnectionStateChange }
  | { kind: "none" };

export function eventProjectionOf(event: AutomationEvent): EventProjection {
  const stored = {
    id: event.id,
    source: event.source,
    eventType: event.eventType,
    payload: event.payload,
    subject: event.subject ?? null,
    occurredAt: new Date(event.occurredAt),
  };
  const read = readPiAgentEvent(stored);
  if (read) {
    const requestId = piAgentEventRequestId(read);
    return {
      kind: "pi",
      read,
      requestKey: requestId === null ? null : piAgentRequestKey(read.agentName, requestId),
    };
  }
  const change = readIntegrationConnectionStateChange(stored);
  return change ? { kind: "connection", change } : { kind: "none" };
}

/** The IDs of the rows the event changes, by table; empty for the tables it leaves alone. */
export function eventProjectionKeys(projection: EventProjection) {
  return {
    agents: projection.kind === "pi" ? [projection.read.agentName] : [],
    requests: projection.kind === "pi" && projection.requestKey ? [projection.requestKey] : [],
    connections: projection.kind === "connection" ? [projection.change.connectionId] : [],
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

/**
 * Folds a newly stored event into the rows it changes, which the caller retrieved by
 * `eventProjectionKeys` in the transaction that stores the event. Each event is stored once, so it
 * is folded once. Events about one agent or connection can be stored concurrently: updates check
 * the row's version, and creating a row another event created meanwhile retries, so the loser folds
 * into the winner's row.
 */
export function projectStoredEvent(
  uow: AutomationHookUnitOfWork,
  {
    event,
    projection,
    agentRows,
    requestRows,
    connectionRows,
  }: {
    event: AutomationEvent;
    projection: EventProjection;
    agentRows: readonly PiAgentRow[];
    requestRows: readonly PiAgentRequestRow[];
    connectionRows: readonly IntegrationConnectionRow[];
  },
) {
  const occurredAt = new Date(event.occurredAt);
  switch (projection.kind) {
    case "pi": {
      const [agentRow] = agentRows;
      const [requestRow] = requestRows;
      const applied = applyPiAgentEvent(
        agentRow ? piAgentState(agentRow) : null,
        requestRow ?? null,
        projection.read,
        { id: event.id, occurredAt },
      );
      const agent = piAgentColumns(applied.agent);
      if (agentRow) {
        updateChangedColumns(uow, "pi_agent", agentRow, agent);
      } else {
        uow.create(
          "pi_agent",
          {
            id: projection.read.agentName,
            displayName: formatPiAgentName(projection.read.agentName),
            ...agent,
          },
          { retryOnUniqueConflict: () => true },
        );
      }
      if (projection.requestKey !== null && applied.request) {
        const request = applied.request;
        if (requestRow) {
          updateChangedColumns(uow, "pi_agent_request", requestRow, request);
        } else {
          uow.create(
            "pi_agent_request",
            { id: projection.requestKey, ...request },
            { retryOnUniqueConflict: () => true },
          );
        }
      }
      const turn = piAgentTurnEndedBy({ id: event.id, occurredAt }, projection.read);
      if (turn) {
        uow.create("pi_agent_turn", turn);
      }
      return;
    }
    case "connection": {
      const { change } = projection;
      const [connectionRow] = connectionRows;
      const fold = applyIntegrationConnectionChange(
        connectionRow ? integrationConnectionFold(connectionRow) : null,
        change,
      );
      const record = integrationConnectionRecord(fold);
      const connection = {
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
      if (connectionRow) {
        updateChangedColumns(uow, "integration_connection", connectionRow, connection);
      } else {
        uow.create(
          "integration_connection",
          { id: change.connectionId, ...connection },
          { retryOnUniqueConflict: () => true },
        );
      }
      uow.create("integration_connection_change", {
        id: change.eventId,
        connectionId: change.connectionId,
        service: change.service,
        kind: change.kind,
        state: change.state,
        label: change.label,
        occurredAt: change.occurredAt,
      });
      return;
    }
    case "none":
      return;
  }
}

/**
 * Updates the row's columns whose value the event changed, and no others: the outbox replicates
 * every column an update sets, and most agent events change a count, not the definition. Checks
 * the row's version even when nothing changed, so a concurrent change still retries the event.
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
  uow.update(table, row.id, (b) => b.set(changed as never).check());
}

function sameColumnValue(stored: unknown, value: unknown) {
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
