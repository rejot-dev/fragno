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

/** The connection state change an event reports, or null; events naming no known source are null. */
export function readIntegrationConnectionStateChange(
  event: StoredEvent,
): IntegrationConnectionStateChange | null {
  const change = readIntegrationConnectionEvent(event);
  const kind = change && kindsByNamespace.get(change.connectionId.split("#", 1)[0]);
  return change && kind
    ? { ...change, eventId: event.id, kind, occurredAt: event.occurredAt }
    : null;
}

/** Connection state changes, newest first. */
export function integrationConnectionStateChanges(
  events: readonly StoredEvent[],
): IntegrationConnectionStateChange[] {
  return events
    .flatMap((event) => {
      const change = readIntegrationConnectionStateChange(event);
      return change ? [change] : [];
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
  /** The name people know the connection by: its label's, or else one read off its address. */
  displayName: string;
  /** What kind of connection it is, such as "MCP" or "Native · telegram". */
  kindLabel: string;
};

/**
 * A connection as its changes so far leave it: the state of its latest change, and the label of its
 * latest labeled change, with when that change happened.
 */
export type IntegrationConnectionFold = {
  latest: IntegrationConnectionStateChange;
  label: IntegrationConnectionLabel | null;
  labelAt: Date | null;
};

/**
 * Applies one change to what the connection's earlier changes left. Disconnections carry no label,
 * so a removed connection keeps the name it had. Of changes made in the same instant, the first
 * applied wins.
 */
export function applyIntegrationConnectionChange(
  current: IntegrationConnectionFold | null,
  change: IntegrationConnectionStateChange,
): IntegrationConnectionFold {
  const relabels =
    change.label !== null && (current?.labelAt == null || change.occurredAt > current.labelAt);
  return {
    latest:
      current === null || change.occurredAt > current.latest.occurredAt ? change : current.latest,
    label: relabels ? change.label : (current?.label ?? null),
    labelAt: relabels ? change.occurredAt : (current?.labelAt ?? null),
  };
}

export function integrationConnectionRecord({
  latest,
  label,
}: IntegrationConnectionFold): IntegrationConnectionRecord {
  const name = label?.name ?? null;
  return {
    connectionId: latest.connectionId,
    service: latest.service,
    kind: latest.kind,
    state: latest.state,
    name,
    authMethod: label?.authMethod ?? null,
    eventId: latest.eventId,
    changedAt: latest.occurredAt,
    displayName: integrationConnectionName({ ...latest, name }),
    kindLabel: describeIntegrationConnectionKind(latest),
  };
}

function currentIntegrationConnections(
  changes: readonly IntegrationConnectionStateChange[],
): IntegrationConnectionRecord[] {
  const connections = new Map<string, IntegrationConnectionFold>();
  for (const change of changes) {
    connections.set(
      change.connectionId,
      applyIntegrationConnectionChange(connections.get(change.connectionId) ?? null, change),
    );
  }
  return [...connections.values()].map(integrationConnectionRecord);
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
    derive: (events) =>
      currentIntegrationConnections(
        events.flatMap((event) => {
          const change = readIntegrationConnectionStateChange(event);
          return change ? [change] : [];
        }),
      ),
  });
}

const integrationConnectionKindLabels = {
  api: "API",
  webhook: "Webhook",
  mcp: "MCP",
  connector: "Connector",
  native: "Native",
} as const satisfies Record<IntegrationConnectionKind, string>;

/** API, webhook, and MCP addresses are their own names; other kinds also name the service. */
export function describeIntegrationConnectionKind(
  connection: Pick<IntegrationConnectionRecord, "kind" | "service">,
) {
  const label = integrationConnectionKindLabels[connection.kind];
  return connection.kind === "connector" || connection.kind === "native"
    ? `${label} · ${connection.service}`
    : label;
}

/**
 * The name the connection's events carry. Connector names only select an account behind an opaque
 * address, so the service leads, followed by any name other than the default, the service itself.
 * Unnamed native slots are named after their service.
 */
function integrationConnectionName(
  connection: Pick<IntegrationConnectionRecord, "connectionId" | "kind" | "service" | "name">,
) {
  if (connection.kind === "connector") {
    return connection.name === null || connection.name === connection.service
      ? connection.service
      : `${connection.service} · ${connection.name}`;
  }
  if (connection.name !== null) {
    return connection.name;
  }
  const [namespace, localId] = splitConnectionId(connection.connectionId);
  return namespace === "backoffice" ? connection.service : localId;
}

function splitConnectionId(connectionId: string) {
  const separator = connectionId.indexOf("#");
  return [connectionId.slice(0, separator), connectionId.slice(separator + 1)] as const;
}
