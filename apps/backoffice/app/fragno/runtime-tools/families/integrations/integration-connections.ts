import {
  connectionEventStates,
  readIntegrationConnectionEvent,
  type IntegrationConnectionLabel,
  type IntegrationConnectionState,
  type IntegrationConnectionStatePayload,
} from "./integration-events";

export type IntegrationConnectionKind = "api" | "webhook" | "mcp" | "connector" | "native";

/**
 * Each address namespace names the source that owns it; native services share one view. Sources may
 * only claim addresses in these namespaces, so every source's connections reach the views.
 */
export const kindsByNamespace = {
  api: "api",
  webhook: "webhook",
  mcp: "mcp",
  connector: "connector",
  backoffice: "native",
  github: "native",
  app: "native",
} as const satisfies Record<string, IntegrationConnectionKind>;

export type IntegrationConnectionNamespace = keyof typeof kindsByNamespace;

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
  const kind = change && kindOfConnectionId(change.connectionId);
  return change && kind
    ? { ...change, eventId: event.id, kind, occurredAt: event.occurredAt }
    : null;
}

/** Any principal may fire `integrations` events, so an address's namespace may be any string. */
function kindOfConnectionId(connectionId: string): IntegrationConnectionKind | null {
  const namespace = connectionId.split("#", 1)[0];
  return Object.hasOwn(kindsByNamespace, namespace)
    ? kindsByNamespace[namespace as IntegrationConnectionNamespace]
    : null;
}

/** A connection event's state, as `event_state` keeps it. */
export type IntegrationConnectionEventState = {
  eventType: keyof typeof connectionEventStates;
  eventId: string;
  payload: IntegrationConnectionStatePayload;
  occurredAt: Date;
  storedAt: Date;
};

/**
 * Every connection, disconnected ones too, by service and then connection ID, from the states of
 * its events. Each event type keeps a state of its own, so a connection's state is the latest of
 * them, and its label the latest labeled one's: disconnections carry none. The `connections` page
 * relation states this again in SQL; keep the two alike.
 */
export function integrationConnectionsOfStates(
  states: readonly IntegrationConnectionEventState[],
): IntegrationConnectionRecord[] {
  const connections = new Map<string, IntegrationConnectionFold>();
  const inOrder = [...states].sort(
    (left, right) =>
      left.occurredAt.getTime() - right.occurredAt.getTime() ||
      left.storedAt.getTime() - right.storedAt.getTime(),
  );
  for (const state of inOrder) {
    const change = connectionChangeOfState(state);
    if (change) {
      connections.set(
        change.connectionId,
        applyIntegrationConnectionChange(connections.get(change.connectionId) ?? null, change),
      );
    }
  }
  return [...connections.values()]
    .map(integrationConnectionRecord)
    .sort(
      (left, right) =>
        compareText(left.service, right.service) ||
        compareText(left.connectionId, right.connectionId),
    );
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function connectionChangeOfState({
  eventType,
  eventId,
  payload,
  occurredAt,
}: IntegrationConnectionEventState): IntegrationConnectionStateChange | null {
  const kind = kindOfConnectionId(payload.connectionId);
  return kind
    ? {
        eventId,
        connectionId: payload.connectionId,
        service: payload.service,
        kind,
        state: connectionEventStates[eventType],
        // Events stored before state events carried labels hold none.
        label: "name" in payload ? { name: payload.name, authMethod: payload.authMethod } : null,
        occurredAt,
      }
    : null;
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
type IntegrationConnectionFold = {
  latest: IntegrationConnectionStateChange;
  label: IntegrationConnectionLabel | null;
  labelAt: Date | null;
};

/**
 * Applies one change to what the connection's earlier changes left. Disconnections carry no label,
 * so a removed connection keeps the name it had. Of changes made in the same instant, the first
 * applied wins.
 */
function applyIntegrationConnectionChange(
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

function integrationConnectionRecord({
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

export const integrationConnectionKindLabels = {
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
