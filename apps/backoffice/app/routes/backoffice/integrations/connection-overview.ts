import {
  readIntegrationConnectionEvent,
  type IntegrationConnectionLabel,
  type IntegrationConnectionState,
} from "@/fragno/runtime-tools/families/integrations/integration-events";

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
 * A connection's latest state change is its current state, labeled by its latest labeled change:
 * disconnections carry no label, so a removed connection keeps the name it had.
 */
export function currentIntegrationConnections(
  changes: readonly IntegrationConnectionStateChange[],
): IntegrationConnectionStateChange[] {
  const latest = new Map<string, IntegrationConnectionStateChange>();
  for (const change of changes) {
    const current = latest.get(change.connectionId);
    if (!current) {
      latest.set(change.connectionId, change);
    } else if (current.label === null && change.label !== null) {
      latest.set(change.connectionId, { ...current, label: change.label });
    }
  }
  return [...latest.values()].sort(
    (left, right) =>
      left.service.localeCompare(right.service) ||
      left.connectionId.localeCompare(right.connectionId),
  );
}
