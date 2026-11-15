import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";

import { compareEventOrder } from "@/fragno/automation/event-order";
import {
  piAgentActivityByEventType,
  type PiAgentActivityKind,
  type PiAgentEvent,
  type PiAgentQueueCounts,
} from "@/fragno/backoffice-capabilities/capabilities/pi";

import { BUILT_IN_PI_AGENT_DEFINITIONS } from "./agent-definitions";
import { formatPiAgentName } from "./pi-agent-name";

/**
 * An agent of the scope as its `pi` events' states record it now. An agent its events record
 * nothing about, such as a built-in agent never prompted, has no latest activity and nothing
 * running. The counts are the queue's as its manager last recorded it; an agent whose events never
 * carried them reads as holding nothing.
 */
export type PiAgentRecord = {
  agentName: string;
  definition: PiAgentDefinition;
  /** Directories list built-in agents first. */
  builtIn: boolean;
  latestKind: PiAgentActivityKind | null;
  latestAt: Date | null;
  /** Whether a turn runs: the queue dispatched it, and it has not settled. */
  answering: boolean;
  /** Work queued for a turn of its own, or for a subagent's slot. */
  queued: number;
  /** Steers handed to the running turn that have not settled with it. */
  steering: number;
  /** Whether the agent was stopped and not resumed since. */
  paused: boolean;
  /** The name people read, such as "Code Reviewer" for `code-reviewer`. */
  displayName: string;
  /** What the agent is doing, or else what it did last, such as "Answering" or "Answered". */
  activity: string;
};

/** A turn that ended, keyed by the event that ended it. */
export type PiAgentTurnRecord = {
  id: string;
  agentName: string;
  outcome: "answered" | "cut-off" | "failed";
  endedAt: Date;
};

/** An agent's latest definition change; `definition` is null when it deleted the agent. */
export type RecordedPiAgentDefinition = {
  agentName: string;
  definition: PiAgentDefinition | null;
  /** The event that recorded the change. */
  eventId: string;
};

/**
 * What a `pi` event's state holds of its agent: definition events carry the definition, and queue
 * and turn-end events the queue their change left, except those stored before events carried it.
 */
type PiAgentStatePayload =
  // States stored before definitions named skill folders lack them; their agents named none.
  | { agentName: string; definition: Omit<PiAgentDefinition, "skills"> & { skills?: string[] } }
  | { agentName: string; queue: PiAgentQueueCounts }
  | { agentName: string };

/** A `pi` event's state, as `event_state` keeps it: each type's latest event of each agent. */
export type PiAgentEventState = {
  eventType: keyof typeof piAgentActivityByEventType;
  eventId: string;
  payload: PiAgentStatePayload;
  occurredAt: Date;
  storedAt: Date;
};

/**
 * An agent as its events' states record it: the latest of them, of its definition changes, and of
 * its stops and resumes, and the queue of the highest revision any carries.
 */
type PiAgentStates = {
  latest: PiAgentEventState;
  definition: PiAgentEventState | null;
  pause: PiAgentEventState | null;
  queue: PiAgentQueueCounts | null;
};

/** Whether the state comes after the other, in the order the `agents` page relation reads too. */
function isLater(state: PiAgentEventState, than: PiAgentEventState | null) {
  return than === null || compareEventOrder(state, than) > 0;
}

function piAgentStatesByName(states: readonly PiAgentEventState[]) {
  const agents = new Map<string, PiAgentStates>();
  for (const state of states) {
    const { payload } = state;
    const kind = piAgentActivityByEventType[state.eventType];
    const agent = agents.get(payload.agentName) ?? {
      latest: state,
      definition: null,
      pause: null,
      queue: null,
    };
    agents.set(payload.agentName, {
      latest: isLater(state, agent.latest) ? state : agent.latest,
      definition:
        (kind === "created" || kind === "updated" || kind === "deleted") &&
        isLater(state, agent.definition)
          ? state
          : agent.definition,
      pause:
        (kind === "stopped" || kind === "resumed") && isLater(state, agent.pause)
          ? state
          : agent.pause,
      queue:
        "queue" in payload &&
        (agent.queue === null || payload.queue.revision > agent.queue.revision)
          ? payload.queue
          : agent.queue,
    });
  }
  return agents;
}

/** The definition a definition change's state records; null for a deletion. */
function definitionOfState(state: PiAgentEventState): PiAgentDefinition | null {
  if (
    piAgentActivityByEventType[state.eventType] === "deleted" ||
    !("definition" in state.payload)
  ) {
    return null;
  }
  const { skills = [], ...definition } = state.payload.definition;
  return { ...definition, skills };
}

/**
 * The scope's agents, from the states of their events: built-in agents, and those their events
 * define. The most recently active come first; agents without activity keep built-in agents
 * first, then go by name. The `agents` page relation states this again in SQL; keep the two alike.
 */
export function piAgentsOfStates(states: readonly PiAgentEventState[]): PiAgentRecord[] {
  const agents = piAgentStatesByName(states);
  const names = new Set([
    ...BUILT_IN_PI_AGENT_DEFINITIONS.map(({ agentName }) => agentName),
    ...agents.keys(),
  ]);
  return [...names]
    .flatMap((agentName) => piAgentRecord(agentName, agents.get(agentName) ?? null) ?? [])
    .sort(
      (left, right) =>
        (right.latestAt?.getTime() ?? -Infinity) - (left.latestAt?.getTime() ?? -Infinity) ||
        Number(right.builtIn) - Number(left.builtIn) ||
        (left.agentName < right.agentName ? -1 : left.agentName > right.agentName ? 1 : 0),
    );
}

/** Every agent a definition change recorded, with its latest. */
export function recordedPiAgentDefinitionsOfStates(
  states: readonly PiAgentEventState[],
): RecordedPiAgentDefinition[] {
  return [...piAgentStatesByName(states)].flatMap(([agentName, { definition }]) =>
    definition
      ? [{ agentName, definition: definitionOfState(definition), eventId: definition.eventId }]
      : [],
  );
}

/**
 * What an agent's `activity` reads: what it is doing, or else what it did last. The `agents` page
 * relation reads the same labels.
 */
export const PI_AGENT_ACTIVITY = {
  none: "No recorded activity",
  answering: "Answering",
  stopped: "Stopped",
  latest: {
    started: "Started a turn",
    answered: "Answered",
    "cut-off": "Turn cut off",
    failed: "Turn failed",
    queued: "Work queued",
    dispatched: "Took queued work",
    dropped: "Dropped queued work",
    created: "Defined",
    updated: "Definition updated",
    deleted: "Deleted",
    stopped: "Stopped",
    resumed: "Resumed",
  } satisfies Record<PiAgentActivityKind, string>,
};

/**
 * The agent people see: a built-in agent, or one whose latest definition change defines it, which
 * takes the place of a built-in agent of the same name; null for any other agent.
 */
function piAgentRecord(agentName: string, agent: PiAgentStates | null): PiAgentRecord | null {
  const defined = agent?.definition ? definitionOfState(agent.definition) : null;
  const definition =
    defined ??
    BUILT_IN_PI_AGENT_DEFINITIONS.find((builtIn) => builtIn.agentName === agentName) ??
    null;
  if (!definition) {
    return null;
  }
  const latestKind = agent ? piAgentActivityByEventType[agent.latest.eventType] : null;
  const answering = (agent?.queue?.running ?? 0) > 0;
  const paused = agent?.pause
    ? piAgentActivityByEventType[agent.pause.eventType] === "stopped"
    : false;
  return {
    agentName,
    definition,
    builtIn: defined === null,
    latestKind,
    latestAt: agent?.latest.occurredAt ?? null,
    answering,
    queued: agent?.queue?.queued ?? 0,
    steering: agent?.queue?.steering ?? 0,
    paused,
    displayName: formatPiAgentName(agentName),
    activity:
      latestKind === null
        ? PI_AGENT_ACTIVITY.none
        : answering
          ? PI_AGENT_ACTIVITY.answering
          : paused
            ? PI_AGENT_ACTIVITY.stopped
            : PI_AGENT_ACTIVITY.latest[latestKind],
  };
}

/** The turn an event ended, or null for any other event. */
export function piAgentTurnEndedBy(
  event: { id: string; occurredAt: Date },
  read: PiAgentEvent | null,
): PiAgentTurnRecord | null {
  return read?.kind === "answered" || read?.kind === "cut-off" || read?.kind === "failed"
    ? { id: event.id, agentName: read.agentName, outcome: read.kind, endedAt: event.occurredAt }
    : null;
}
