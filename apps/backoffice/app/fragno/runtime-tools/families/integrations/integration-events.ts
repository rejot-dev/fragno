import {
  integrationAuthMethodSchema,
  integrationConnectionIdSchema,
  type IntegrationConnection,
  type IntegrationInspection,
} from "@fragno-dev/backoffice-api/v0/integrations";
import {
  type BackofficeContextScope,
  backofficeScopeOrganization,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type {
  AutomationsCommands,
  BackofficeRpcContext,
} from "@/backoffice-runtime/object-registry";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";

export const INTEGRATIONS_EVENT_SOURCE = "integrations";

/** An existing connection is ready or unavailable; only removal reports disconnected. */
export type IntegrationConnectionState = "ready" | "unavailable";

/** How an existing connection presents itself; its state events carry it so views need no source read. */
export type IntegrationConnectionLabel = Pick<IntegrationConnection, "name" | "authMethod">;

const integrationConnectionLabelSchema = z.strictObject({
  name: z.string().describe("The connection's display name, as integrations.list reports it."),
  authMethod: integrationAuthMethodSchema.nullable(),
});

/** For sources whose readiness is exactly stored configuration plus authorization. */
export function connectionStateOfInspection(
  inspection: IntegrationInspection,
): IntegrationConnectionState {
  if (inspection.configuration.status === "missing") {
    return "unavailable";
  }
  // Not-checked comes from sources that keep no authorization state beyond the saved configuration.
  switch (inspection.authorization.status) {
    case "available":
    case "not-required":
    case "not-checked":
      return "ready";
    case "missing":
    case "expired":
      return "unavailable";
    default:
      throw new Error("Integration authorization status is unsupported.", {
        cause: inspection.authorization satisfies never,
      });
  }
}

const integrationConnectionSubjectSchema = z.object({
  scope: z.looseObject({ kind: z.string().min(1) }),
  orgId: z.string().min(1).optional(),
  service: z.string().min(1).describe("Service ID from integrations.discover, e.g. api."),
  // Any principal may fire this source, so a stored address is parsed, not trusted.
  connectionId: integrationConnectionIdSchema.describe(
    "Integration address, e.g. api#billing; it resolves in the event's scope.",
  ),
});

const connectionEventStates = {
  "connection.ready": "ready",
  "connection.unavailable": "unavailable",
  "connection.disconnected": "disconnected",
} as const satisfies Record<string, IntegrationConnectionState | "disconnected">;

/**
 * Reads a stored event as a connection state change, or null if it is not one. Any principal that
 * may emit events can use this source, so stored events are validated rather than trusted.
 */
export function readIntegrationConnectionEvent(event: {
  source: string;
  eventType: string;
  payload: unknown;
  subject: unknown;
}) {
  const subject = integrationConnectionSubjectSchema.safeParse(event.subject);
  if (
    event.source !== INTEGRATIONS_EVENT_SOURCE ||
    !Object.hasOwn(connectionEventStates, event.eventType) ||
    !subject.success
  ) {
    return null;
  }
  const label = integrationConnectionLabelSchema.safeParse(event.payload);
  return {
    state: connectionEventStates[event.eventType as keyof typeof connectionEventStates],
    service: subject.data.service,
    connectionId: subject.data.connectionId,
    // Disconnections carry none, and neither do events recorded before state events carried labels.
    label: label.success ? label.data : null,
  };
}

type RecordedConnectionState = {
  state: IntegrationConnectionState | "disconnected";
  service: string;
  /** The event that recorded this state. */
  eventId: string;
};

/** Each connection's latest state in one scope's recorded connection events. */
export async function readRecordedConnectionStates(
  automations: Pick<AutomationsCommands, "listEventsOfType">,
): Promise<Map<string, RecordedConnectionState>> {
  const latest = new Map<string, RecordedConnectionState & { at: [number, number] }>();
  for (const eventType of Object.keys(connectionEventStates)) {
    let cursor: string | null = null;
    do {
      const page = await automations.listEventsOfType({
        source: INTEGRATIONS_EVENT_SOURCE,
        eventType,
        cursor,
      });
      for (const event of page.events) {
        const change = readIntegrationConnectionEvent(event);
        if (!change) {
          continue;
        }
        // Changes made in the same instant are ordered by when they were stored.
        const at: [number, number] = [Date.parse(event.occurredAt), Date.parse(event.createdAt)];
        const current = latest.get(change.connectionId);
        if (
          !current ||
          at[0] > current.at[0] ||
          (at[0] === current.at[0] && at[1] > current.at[1])
        ) {
          latest.set(change.connectionId, {
            state: change.state,
            service: change.service,
            eventId: event.id,
            at,
          });
        }
      }
      cursor = page.cursor;
    } while (cursor !== null);
  }
  return latest;
}

// Every change that leaves the state fires, so consumers must tolerate repeats.
const repeatNote =
  "Fires for changes made through integrations.*, native pages, OAuth callbacks, and provider webhooks, each time a change leaves the connection in this state.";

/** Connection state changes every integration service reports, keyed by the integration address. */
export const integrationConnectionEvents = [
  {
    source: INTEGRATIONS_EVENT_SOURCE,
    eventType: "connection.ready",
    label: "Integration connection ready",
    description: `The connection's stored configuration and authorization are in place. Providers can still reject requests; integrations.verify checks live access. ${repeatNote}`,
    payloadSchema: integrationConnectionLabelSchema,
    subjectSchema: integrationConnectionSubjectSchema,
    example: { name: "Billing API", authMethod: "bearer" },
  },
  {
    source: INTEGRATIONS_EVENT_SOURCE,
    eventType: "connection.unavailable",
    label: "Integration connection unavailable",
    description: `The connection exists but cannot be used, for example while consent is pending, after credentials were cleared or rejected, or while the provider installation is suspended. It also fires when an API or MCP access token without a refresh token expires. integrations.get lists the next steps. ${repeatNote}`,
    payloadSchema: integrationConnectionLabelSchema,
    subjectSchema: integrationConnectionSubjectSchema,
    example: { name: "Billing API", authMethod: "bearer" },
  },
  {
    source: INTEGRATIONS_EVENT_SOURCE,
    eventType: "connection.disconnected",
    label: "Integration connection disconnected",
    description: `The connection was removed; its address resolves again only after setup. ${repeatNote}`,
    payloadSchema: z.strictObject({}),
    subjectSchema: integrationConnectionSubjectSchema,
    example: {},
  },
] as const;

/**
 * Records a state change reported by the source that owns the connection. Sources call this from
 * their own durable hooks, because native pages, OAuth callbacks, and provider webhooks change
 * connections without passing through integrations.*.
 */
export async function recordIntegrationConnectionState(
  automations: Pick<AutomationsCommands, "ingestEvent">,
  change: {
    /** Unique per source change, such as the durable hook ID, so redelivery records one event. */
    id: string;
    scope: BackofficeContextScope;
    service: string;
    connectionId: string;
    occurredAt: Date;
  } & (
    | { state: IntegrationConnectionState; label: IntegrationConnectionLabel }
    | { state: "disconnected" }
  ),
  context: BackofficeRpcContext,
) {
  const organization = backofficeScopeOrganization(change.scope);
  await automations.ingestEvent(
    {
      id: `${change.id}:connection.${change.state}`,
      scopeRestriction: null,
      scope: change.scope,
      source: INTEGRATIONS_EVENT_SOURCE,
      eventType: `connection.${change.state}`,
      occurredAt: change.occurredAt.toISOString(),
      payload: change.state === "disconnected" ? {} : change.label,
      actors: { initiator: AUTOMATION_SYSTEM_INITIATOR, principal: null, delegation: [] },
      subject: {
        scope: change.scope,
        ...(organization ? { orgId: organization.orgId } : {}),
        service: change.service,
        connectionId: change.connectionId,
      },
      causation: { kind: "origin" },
    },
    context,
  );
}

/**
 * Outbox item a singleton configuration slot writes when it is saved or cleared. It carries its
 * scope because clearing removes the stored configuration the item is dispatched after.
 */
export type IntegrationSlotOutboxItem = {
  id: string;
  type: "connection.ready" | "connection.disconnected";
  createdAt: string;
  scope: BackofficeContextScope;
};

/** Records a slot outbox item as the connection state it reports. */
export async function recordIntegrationSlotChange(
  automationsFor: (scope: BackofficeContextScope) => Pick<AutomationsCommands, "ingestEvent">,
  item: IntegrationSlotOutboxItem,
  slot: Pick<IntegrationConnection, "connectionId" | "integrationId" | "name" | "authMethod">,
) {
  const change = {
    id: item.id,
    scope: item.scope,
    service: slot.integrationId,
    connectionId: slot.connectionId,
    occurredAt: new Date(item.createdAt),
  };
  await recordIntegrationConnectionState(
    automationsFor(item.scope),
    item.type === "connection.ready"
      ? { ...change, state: "ready", label: { name: slot.name, authMethod: slot.authMethod } }
      : { ...change, state: "disconnected" },
    { propagationContext: null },
  );
}
