import { isDeepStrictEqual } from "node:util";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";
import type { PiAgentNotification } from "@fragno-dev/backoffice-api/v0/pi-conversation/notification-entry";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type {
  AutomationsCommands,
  BackofficeRpcContext,
} from "@/backoffice-runtime/object-registry";
import {
  PI_AGENT_AUTOMATION_EVENTS,
  PI_AUTOMATION_SOURCE,
  PI_QUEUE_AUTOMATION_EVENTS,
  piAgentEventSubject,
  type PiAgentQueueCounts,
} from "@/fragno/backoffice-capabilities/capabilities/pi";

import type { PiAgentChange, PiAgentQueueChange } from "./pi-agent-queue";
import type { PiAgentTurnProvenance } from "./pi-manager-schema";

type DefinitionChangeKind = "created" | "updated" | "deleted";

export type PiAgentBackfilledEvent = {
  agentName: string;
  eventType: (typeof PI_AGENT_AUTOMATION_EVENTS)[DefinitionChangeKind]["eventType"];
};

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
    payload: {
      agentName: change.agentName,
      ...("definition" in change ? { definition: change.definition } : {}),
    },
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
  const { agentName, requestId, provenance, queue } = change;
  return {
    id,
    scope,
    // Automations started by this event inherit the sender's ceiling, never a wider one.
    scopeRestriction: provenance.scopeRestriction,
    source: PI_AUTOMATION_SOURCE,
    eventType: PI_QUEUE_AUTOMATION_EVENTS[change.kind].eventType,
    occurredAt: occurredAt.toISOString(),
    payload: {
      agentName,
      queue,
      ...(change.kind === "added"
        ? { type: change.type }
        : change.kind === "dispatched"
          ? { turnRequestId: change.turnRequestId }
          : { reason: change.reason }),
    },
    actors: provenance.actors,
    subject: { ...piAgentEventSubject(scope, agentName), requestId },
    causation: { kind: "origin" },
  };
}

/**
 * What tells a prompt's sender that the queue dropped it, shaped as the `queue.dropped` event; a
 * notification, not a recorded event, so it carries no queue.
 */
export function piAgentDroppedReply({
  id,
  scope,
  occurredAt,
  dropped,
}: {
  id: string;
  scope: BackofficeContextScope;
  occurredAt: Date;
  dropped: { agentName: string; requestId: string; reason: string };
}): PiAgentNotification["event"] {
  const { agentName, requestId, reason } = dropped;
  return {
    id,
    source: PI_AUTOMATION_SOURCE,
    eventType: PI_QUEUE_AUTOMATION_EVENTS.dropped.eventType,
    occurredAt: occurredAt.toISOString(),
    payload: { agentName, reason },
    subject: { ...piAgentEventSubject(scope, agentName), requestId },
  };
}

/**
 * The `turn.*` event recording how a turn ended, as its agent reported it, with the queue its
 * settling left: the agent knows the turn, and only the queue its counts. It occurred when the
 * queue settled it, as `queue.*` events do: subagents end in any order, so the turn that ended
 * first may settle last, and a type's latest event must carry its highest revision.
 */
export function piAgentTurnEndEvent(
  event: AutomationEvent,
  queue: PiAgentQueueCounts,
  settledAt: Date,
): AutomationEvent {
  return { ...event, occurredAt: settledAt.toISOString(), payload: { ...event.payload, queue } };
}

/**
 * Records, as the caller, what the scope's agent events must add for its defined agents to read as
 * they are: `agent.created` for an agent they lack or record deleted, `agent.updated` for a
 * definition they record differently, and `agent.deleted` for an agent they record that no longer
 * is. Each event is keyed by the recorded event it follows, so a rerun records nothing new.
 */
export async function backfillPiAgentEvents({
  automations,
  scope,
  definitions,
  occurredAt,
  provenance,
  context,
}: {
  automations: Pick<AutomationsCommands, "ingestEvent" | "listRecordedPiAgentDefinitions">;
  scope: BackofficeContextScope;
  /** The scope's own definitions; built-in agents are Backoffice's, not the scope's. */
  definitions: readonly PiAgentDefinition[];
  occurredAt: Date;
  /**
   * The caller's, so automations its events start stay within the caller's delegation; recording
   * them as the system would run them with none.
   */
  provenance: PiAgentTurnProvenance;
  context: BackofficeRpcContext;
}): Promise<PiAgentBackfilledEvent[]> {
  const recorded = new Map(
    (await automations.listRecordedPiAgentDefinitions()).map((recorded) => [
      recorded.agentName,
      recorded,
    ]),
  );
  const changes: { kind: DefinitionChangeKind; definition: PiAgentDefinition; after: string }[] =
    [];
  for (const definition of definitions) {
    const latest = recorded.get(definition.agentName);
    if (!latest || latest.definition === null) {
      changes.push({ kind: "created", definition, after: latest?.eventId ?? "none" });
    } else if (!isDeepStrictEqual(latest.definition, definition)) {
      changes.push({ kind: "updated", definition, after: latest.eventId });
    }
  }
  const defined = new Set(definitions.map((definition) => definition.agentName));
  for (const [agentName, latest] of recorded) {
    if (latest.definition !== null && !defined.has(agentName)) {
      changes.push({ kind: "deleted", definition: latest.definition, after: latest.eventId });
    }
  }

  for (const { kind, definition, after } of changes) {
    await automations.ingestEvent(
      piAgentChangeEvent({
        id: `pi-agent-backfill:${definition.agentName}:${after}`,
        scope,
        occurredAt,
        change: {
          kind,
          agentName: definition.agentName,
          definition,
          provenance,
        },
      }),
      context,
    );
  }
  return changes.map(({ kind, definition }) => ({
    agentName: definition.agentName,
    eventType: PI_AGENT_AUTOMATION_EVENTS[kind].eventType,
  }));
}
