import {
  createLiveQueryCollection,
  eq,
  type Collection,
  type InitialQueryBuilder,
} from "@tanstack/react-db";

import type { AutomationTableCollections } from "@/fragno/automation/tanstack/collections";
import { createDerivedCollection } from "@/fragno/tanstack/derived-collection";

import {
  INTEGRATIONS_EVENT_SOURCE,
  readIntegrationConnectionEvent,
  type IntegrationConnectionLabel,
  type IntegrationConnectionState,
} from "./integration-events";

export type IntegrationConnectionKind = "api" | "webhook" | "mcp" | "connector" | "native";

/** Each address namespace names the source that owns it; native services share one view. */
const kindsByNamespace = new Map<string, IntegrationConnectionKind>([
  ["api", "api"],
  ["webhook", "webhook"],
  ["mcp", "mcp"],
  ["connector", "connector"],
  ["backoffice", "native"],
  ["github", "native"],
  ["app", "native"],
]);

/** The events that report connection state, with the fields reading them takes. */
export function integrationEventsQuery(
  query: InitialQueryBuilder,
  collections: Pick<AutomationTableCollections, "events">,
) {
  return query
    .from({ event: collections.events })
    .where(({ event }) => eq(event.source, INTEGRATIONS_EVENT_SOURCE))
    .select(({ event }) => ({
      id: event.id,
      source: event.source,
      eventType: event.eventType,
      payload: event.payload,
      subject: event.subject,
      occurredAt: event.occurredAt,
    }));
}

type StoredEvent = {
  id: string;
  source: string;
  eventType: string;
  payload: unknown;
  subject: unknown;
  occurredAt: Date;
};

export type IntegrationConnectionStateChange = {
  eventId: string;
  connectionId: string;
  service: string;
  kind: IntegrationConnectionKind;
  state: IntegrationConnectionState | "disconnected";
  label: IntegrationConnectionLabel | null;
  occurredAt: Date;
};

/** Connection state changes, newest first; events naming no known source are left out. */
export function integrationConnectionStateChanges(
  events: readonly StoredEvent[],
): IntegrationConnectionStateChange[] {
  return events
    .flatMap((event) => {
      const change = readIntegrationConnectionEvent(event);
      const kind = change && kindsByNamespace.get(change.connectionId.split("#", 1)[0]);
      return change && kind
        ? [{ ...change, eventId: event.id, kind, occurredAt: event.occurredAt }]
        : [];
    })
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
}

/**
 * A connection as it stands: the state of its latest change, named by its latest labeled change.
 * `name` and `authMethod` are null until a change carries a label.
 */
export type IntegrationConnectionRecord = {
  connectionId: string;
  service: string;
  kind: IntegrationConnectionKind;
  state: IntegrationConnectionState | "disconnected";
  name: string | null;
  authMethod: IntegrationConnectionLabel["authMethod"];
  eventId: string;
  changedAt: Date;
};

/**
 * Each connection's latest state change is its current state, labeled by its latest labeled
 * change: disconnections carry no label, so a removed connection keeps the name it had.
 */
function currentIntegrationConnections(
  changes: readonly IntegrationConnectionStateChange[],
): IntegrationConnectionRecord[] {
  const latest = new Map<string, IntegrationConnectionStateChange>();
  for (const change of changes) {
    const current = latest.get(change.connectionId);
    if (!current) {
      latest.set(change.connectionId, change);
    } else if (current.label === null && change.label !== null) {
      latest.set(change.connectionId, { ...current, label: change.label });
    }
  }
  return [...latest.values()].map((change) => ({
    connectionId: change.connectionId,
    service: change.service,
    kind: change.kind,
    state: change.state,
    name: change.label?.name ?? null,
    authMethod: change.label?.authMethod ?? null,
    eventId: change.eventId,
    changedAt: change.occurredAt,
  }));
}

/** Every connection the scope's integration events report, as it currently stands. */
export function createIntegrationConnectionsCollection(
  collections: Pick<AutomationTableCollections, "events">,
): Collection<IntegrationConnectionRecord, string> {
  return createDerivedCollection({
    source: createLiveQueryCollection({
      query: (query) => integrationEventsQuery(query, collections),
    }),
    getKey: (connection) => connection.connectionId,
    derive: (events) => currentIntegrationConnections(integrationConnectionStateChanges(events)),
  });
}
