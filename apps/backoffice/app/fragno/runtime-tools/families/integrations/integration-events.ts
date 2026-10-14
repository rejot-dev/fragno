import type { IntegrationInspection } from "@fragno-dev/backoffice-api/v0/integrations";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import type { AutomationsObject, BackofficeRpcContext } from "@/backoffice-runtime/object-registry";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";

export const INTEGRATIONS_EVENT_SOURCE = "integrations";

/** An existing connection is ready or unavailable; only removal reports disconnected. */
export type IntegrationConnectionState = "ready" | "unavailable";

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
  connectionId: z
    .string()
    .min(1)
    .describe("Integration address, e.g. api#billing; it resolves in the event's scope."),
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
  return {
    state: connectionEventStates[event.eventType as keyof typeof connectionEventStates],
    service: subject.data.service,
    connectionId: subject.data.connectionId,
  };
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
    payloadSchema: z.strictObject({}),
    subjectSchema: integrationConnectionSubjectSchema,
    example: {},
  },
  {
    source: INTEGRATIONS_EVENT_SOURCE,
    eventType: "connection.unavailable",
    label: "Integration connection unavailable",
    description: `The connection exists but cannot be used, for example while consent is pending, after credentials were cleared or rejected, or while the provider installation is suspended. It also fires when an API or MCP access token without a refresh token expires. integrations.get lists the next steps. ${repeatNote}`,
    payloadSchema: z.strictObject({}),
    subjectSchema: integrationConnectionSubjectSchema,
    example: {},
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
  automations: Pick<AutomationsObject, "ingestEvent">,
  change: {
    /** Unique per source change, such as the durable hook ID, so redelivery records one event. */
    id: string;
    scope: BackofficeContextScope;
    service: string;
    connectionId: string;
    state: IntegrationConnectionState | "disconnected";
    occurredAt: Date;
  },
  context: BackofficeRpcContext,
) {
  await automations.ingestEvent(
    {
      id: `${change.id}:connection.${change.state}`,
      scopeRestriction: null,
      scope: change.scope,
      source: INTEGRATIONS_EVENT_SOURCE,
      eventType: `connection.${change.state}`,
      occurredAt: change.occurredAt.toISOString(),
      payload: {},
      actors: { initiator: AUTOMATION_SYSTEM_INITIATOR, principal: null, delegation: [] },
      subject: {
        scope: change.scope,
        ...(change.scope.kind === "org" || change.scope.kind === "project"
          ? { orgId: change.scope.orgId }
          : {}),
        service: change.service,
        connectionId: change.connectionId,
      },
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
  automationsFor: (scope: BackofficeContextScope) => Pick<AutomationsObject, "ingestEvent">,
  item: IntegrationSlotOutboxItem,
  connection: { service: string; connectionId: string },
) {
  await recordIntegrationConnectionState(
    automationsFor(item.scope),
    {
      id: item.id,
      scope: item.scope,
      ...connection,
      state: item.type === "connection.ready" ? "ready" : "disconnected",
      occurredAt: new Date(item.createdAt),
    },
    { propagationContext: null },
  );
}
