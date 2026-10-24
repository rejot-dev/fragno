// Copies of how Backoffice reads `pi` and `integrations` events, from
// `apps/backoffice/app/fragno/backoffice-capabilities/capabilities/pi.ts` and
// `apps/backoffice/app/fragno/runtime-tools/families/integrations/`. Importing those modules pulls
// Backoffice's Worker runtime types into this package, so keep these in step by hand.
import {
  integrationAuthMethodSchema,
  integrationConnectionIdSchema,
} from "@fragno-dev/backoffice-api/v0/integrations";
import { piAgentDefinitionSchema, type PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import { z } from "zod";

/** The fields of a stored automation event the readers interpret. */
type StoredEvent = {
  source: string;
  eventType: string;
  payload: unknown;
  subject: unknown;
};

const agentActivityByEventType = {
  "turn.started": "started",
  "turn.completed": "answered",
  "turn.aborted": "cut-off",
  "turn.failed": "failed",
  "queue.added": "queued",
  "queue.dispatched": "dispatched",
  "queue.dropped": "dropped",
  "agent.created": "created",
  "agent.updated": "updated",
  "agent.deleted": "deleted",
  "agent.stopped": "stopped",
  "agent.resumed": "resumed",
} as const;

export type PiAgentActivityKind =
  (typeof agentActivityByEventType)[keyof typeof agentActivityByEventType];

type PiAgentRequestKind = "started" | "answered" | "cut-off" | "failed" | "dispatched" | "dropped";

export type PiAgentEvent =
  | { agentName: string; kind: "created" | "updated" | "deleted"; definition: PiAgentDefinition }
  | { agentName: string; kind: "stopped" | "resumed" }
  | { agentName: string; kind: PiAgentRequestKind; requestId: string }
  | { agentName: string; kind: "queued"; requestId: string; steer: boolean };

const agentSubjectSchema = z.object({
  orgId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).optional(),
  agentName: z.string().trim().min(1),
});
const requestSubjectSchema = agentSubjectSchema.extend({ requestId: z.string().trim().min(1) });

/** The agent a stored `pi` event is about and what happened to it; null for any other event. */
export function readPiAgentEvent(event: StoredEvent): PiAgentEvent | null {
  if (event.source !== "pi" || !Object.hasOwn(agentActivityByEventType, event.eventType)) {
    return null;
  }
  const kind = agentActivityByEventType[event.eventType as keyof typeof agentActivityByEventType];
  if (kind === "created" || kind === "updated" || kind === "deleted") {
    const subject = agentSubjectSchema.safeParse(event.subject);
    const payload = z.object({ definition: piAgentDefinitionSchema }).safeParse(event.payload);
    return subject.success && payload.success
      ? { agentName: subject.data.agentName, kind, definition: payload.data.definition }
      : null;
  }
  if (kind === "stopped" || kind === "resumed") {
    const subject = agentSubjectSchema.safeParse(event.subject);
    return subject.success ? { agentName: subject.data.agentName, kind } : null;
  }
  const subject = requestSubjectSchema.safeParse(event.subject);
  if (!subject.success) {
    return null;
  }
  const { agentName, requestId } = subject.data;
  if (kind === "queued") {
    const payload = z
      .object({ type: z.enum(["prompt", "notification", "steer"]) })
      .safeParse(event.payload);
    return payload.success
      ? { agentName, kind, requestId, steer: payload.data.type === "steer" }
      : null;
  }
  return { agentName, kind, requestId };
}

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

const connectionEventStates = {
  "connection.ready": "ready",
  "connection.unavailable": "unavailable",
  "connection.disconnected": "disconnected",
} as const;

const integrationConnectionLabelSchema = z.strictObject({
  name: z.string(),
  authMethod: integrationAuthMethodSchema.nullable(),
});

export type IntegrationConnectionLabel = z.output<typeof integrationConnectionLabelSchema>;

const integrationConnectionSubjectSchema = z.object({
  scope: z.looseObject({ kind: z.string().min(1) }),
  orgId: z.string().min(1).optional(),
  service: z.string().min(1),
  connectionId: integrationConnectionIdSchema,
});

export type IntegrationConnectionStateChange = {
  connectionId: string;
  service: string;
  kind: IntegrationConnectionKind;
  state: (typeof connectionEventStates)[keyof typeof connectionEventStates];
  label: IntegrationConnectionLabel | null;
};

/** A stored event as a connection state change, or null if it is not one of a known source. */
export function readIntegrationConnectionStateChange(
  event: StoredEvent,
): IntegrationConnectionStateChange | null {
  const subject = integrationConnectionSubjectSchema.safeParse(event.subject);
  if (
    event.source !== "integrations" ||
    !Object.hasOwn(connectionEventStates, event.eventType) ||
    !subject.success
  ) {
    return null;
  }
  const kind = kindsByNamespace.get(subject.data.connectionId.split("#", 1)[0]);
  if (!kind) {
    return null;
  }
  const label = integrationConnectionLabelSchema.safeParse(event.payload);
  return {
    connectionId: subject.data.connectionId,
    service: subject.data.service,
    kind,
    state: connectionEventStates[event.eventType as keyof typeof connectionEventStates],
    // Disconnections carry none, and neither do events recorded before state events carried labels.
    label: label.success ? label.data : null,
  };
}

const integrationConnectionKindLabels = {
  api: "API",
  webhook: "Webhook",
  mcp: "MCP",
  connector: "Connector",
  native: "Native",
} as const satisfies Record<IntegrationConnectionKind, string>;

/** API, webhook, and MCP addresses are their own names; other kinds also name the service. */
export function describeIntegrationConnectionKind(connection: {
  kind: IntegrationConnectionKind;
  service: string;
}): string {
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
export function integrationConnectionName(connection: {
  connectionId: string;
  kind: IntegrationConnectionKind;
  service: string;
  name: string | null;
}): string {
  if (connection.kind === "connector") {
    return connection.name === null || connection.name === connection.service
      ? connection.service
      : `${connection.service} · ${connection.name}`;
  }
  if (connection.name !== null) {
    return connection.name;
  }
  const separator = connection.connectionId.indexOf("#");
  return connection.connectionId.slice(0, separator) === "backoffice"
    ? connection.service
    : connection.connectionId.slice(separator + 1);
}
