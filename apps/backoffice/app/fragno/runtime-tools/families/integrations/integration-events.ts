import { z } from "zod";

import type { AutomationsObject, BackofficeRpcContext } from "@/backoffice-runtime/object-registry";
import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";

const INTEGRATIONS_EVENT_SOURCE = "integrations";

type IntegrationConnectionState = "ready" | "unavailable" | "disconnected";

const integrationConnectionSubjectSchema = z.object({
  scope: z.looseObject({ kind: z.string().min(1) }),
  orgId: z.string().min(1).optional(),
  service: z.string().min(1).describe("Service ID from integrations.discover, e.g. api."),
  connectionId: z
    .string()
    .min(1)
    .describe("Integration address, e.g. api#billing; it resolves in the event's scope."),
});

// Every change that leaves the state fires, so consumers must tolerate repeats.
const repeatNote =
  "Fires for changes made through integrations.*, native pages, OAuth callbacks, and provider webhooks, each time a change leaves the connection in this state. Time passing alone, such as a token expiring, does not fire.";

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
    description: `The connection exists but cannot be used, for example while consent is pending, after credentials were cleared or rejected, or while the provider installation is suspended. integrations.describe lists the next steps. ${repeatNote}`,
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
    scope: BackofficeRoutableScope;
    service: string;
    connectionId: string;
    state: IntegrationConnectionState;
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
