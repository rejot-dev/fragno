import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  PI_AGENT_AUTOMATION_EVENTS,
  PI_AUTOMATION_SOURCE,
  PI_QUEUE_AUTOMATION_EVENTS,
  piAgentEventSubject,
} from "@/fragno/backoffice-capabilities/capabilities/pi";

import type { PiAgentChange, PiAgentQueueChange } from "./pi-agent-queue";

/** The `agent.*` event recording one change to an agent, attributed by the change's provenance. */
export function piAgentChangeEvent({
  id,
  scope,
  occurredAt,
  change,
}: {
  /** Unique per change, such as the durable hook ID, so redelivery records one event. */
  id: string;
  scope: BackofficeContextScope;
  occurredAt: Date;
  change: PiAgentChange;
}): AutomationEvent {
  return {
    id,
    scope,
    // Automations started by this event inherit the requester's ceiling, never a wider one.
    scopeRestriction: change.provenance.scopeRestriction,
    source: PI_AUTOMATION_SOURCE,
    eventType: PI_AGENT_AUTOMATION_EVENTS[change.kind].eventType,
    occurredAt: occurredAt.toISOString(),
    payload: "definition" in change ? { definition: change.definition } : {},
    actors: change.provenance.actors,
    subject: piAgentEventSubject(scope, change.agentName),
    causation: { kind: "origin" },
  };
}

/** The `queue.*` event recording what happened to waiting work, attributed to its sender. */
export function piAgentQueueEvent({
  id,
  scope,
  occurredAt,
  change,
}: {
  /** Unique per change, such as the durable hook ID, so redelivery records one event. */
  id: string;
  scope: BackofficeContextScope;
  occurredAt: Date;
  change: PiAgentQueueChange;
}): AutomationEvent {
  const { agentName, requestId, provenance } = change;
  return {
    id,
    scope,
    // Automations started by this event inherit the sender's ceiling, never a wider one.
    scopeRestriction: provenance.scopeRestriction,
    source: PI_AUTOMATION_SOURCE,
    eventType: PI_QUEUE_AUTOMATION_EVENTS[change.kind].eventType,
    occurredAt: occurredAt.toISOString(),
    payload:
      change.kind === "added"
        ? { type: change.type }
        : change.kind === "dispatched"
          ? { turnRequestId: change.turnRequestId }
          : { reason: change.reason },
    actors: provenance.actors,
    subject: { ...piAgentEventSubject(scope, agentName), requestId },
    causation: { kind: "origin" },
  };
}
