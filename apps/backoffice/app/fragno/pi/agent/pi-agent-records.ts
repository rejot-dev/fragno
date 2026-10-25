import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";

import { createLiveQueryCollection, eq, type Collection } from "@tanstack/react-db";

import type { AutomationTableCollections } from "@/fragno/automation/tanstack/collections";
import {
  PI_AUTOMATION_SOURCE,
  readPiAgentEvent,
  type PiAgentActivityKind,
  type PiAgentEvent,
} from "@/fragno/backoffice-capabilities/capabilities/pi";
import { createDerivedCollection } from "@/fragno/tanstack/derived-collection";

import { BUILT_IN_PI_AGENT_DEFINITIONS } from "./agent-definitions";
import { formatPiAgentName } from "./pi-agent-name";

type StoredPiEvent = {
  id: string;
  source: string;
  eventType: string;
  payload: unknown;
  subject: unknown;
  occurredAt: Date;
  createdAt: Date;
};

/**
 * An agent of the scope as its `pi` events record it now. An agent its events record nothing
 * about, such as a built-in agent never prompted, has no latest activity and nothing running.
 */
export type PiAgentRecord = {
  agentName: string;
  definition: PiAgentDefinition;
  /** Directories list built-in agents first. */
  builtIn: boolean;
  latestKind: PiAgentActivityKind | null;
  latestAt: Date | null;
  /** Whether a turn has started that has not ended. */
  answering: boolean;
  /** Work queued for a turn of its own. */
  queued: number;
  /** Work waiting to steer the running turn. */
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

/** When an event happened; changes made in the same instant are ordered by when they were stored. */
export type PiAgentEventOrder = { occurredAt: Date; createdAt: Date };

function isLater(event: PiAgentEventOrder, than: PiAgentEventOrder | null) {
  return (
    than === null ||
    event.occurredAt > than.occurredAt ||
    (event.occurredAt.getTime() === than.occurredAt.getTime() && event.createdAt > than.createdAt)
  );
}

/**
 * What one request's events record of it. Events are matched by request ID, not order, so a turn
 * whose start was recorded after its end does not read as running.
 */
export type PiAgentRequestState = {
  started: boolean;
  ended: boolean;
  /** Whether it was queued, and as a steer by its latest queueing. */
  waiting: boolean;
  steer: boolean;
  /** Whether its wait ended: dispatched, dropped, or started or ended by Pi. */
  dequeued: boolean;
};

/**
 * An agent as its events record it: its latest event, definition change, and stop or resume, and
 * how many of its requests are running, queued, and steering.
 */
export type PiAgentState = {
  latest: PiAgentEventOrder & { kind: PiAgentActivityKind };
  definition: (PiAgentEventOrder & { definition: PiAgentDefinition | null }) | null;
  pause: (PiAgentEventOrder & { paused: boolean }) | null;
  running: number;
  queued: number;
  steering: number;
};

const NO_REQUEST: PiAgentRequestState = {
  started: false,
  ended: false,
  waiting: false,
  steer: false,
  dequeued: false,
};

/** The event's request, for an event about one. */
export function piAgentEventRequestId(read: PiAgentEvent): string | null {
  return "requestId" in read ? read.requestId : null;
}

function requestAfter(request: PiAgentRequestState, read: PiAgentEvent): PiAgentRequestState {
  switch (read.kind) {
    case "started":
      return { ...request, started: true, dequeued: true };
    case "answered":
    case "cut-off":
    case "failed":
      // A steer its turn's stop cut off before Pi placed it ends without starting.
      return { ...request, ended: true, dequeued: true };
    case "queued":
      return { ...request, waiting: true, steer: read.steer };
    case "dispatched":
    case "dropped":
      return { ...request, dequeued: true };
    case "created":
    case "updated":
    case "deleted":
    case "stopped":
    case "resumed":
      return request;
  }
  throw new Error("Unsupported Pi agent event.");
}

function requestCounts(request: PiAgentRequestState) {
  const waiting = request.waiting && !request.dequeued;
  return {
    running: request.started && !request.ended ? 1 : 0,
    queued: waiting && !request.steer ? 1 : 0,
    steering: waiting && request.steer ? 1 : 0,
  };
}

/**
 * Applies one of an agent's events to what its earlier events recorded: to the agent, and for a
 * request event to that request, which is null until an event names it. Events may come in any
 * order; later ones by occurrence win.
 */
export function applyPiAgentEvent(
  agent: PiAgentState | null,
  request: PiAgentRequestState | null,
  read: PiAgentEvent,
  order: PiAgentEventOrder,
): { agent: PiAgentState; request: PiAgentRequestState | null } {
  const latest = { ...order, kind: read.kind };
  let next: PiAgentState = agent
    ? { ...agent, latest: isLater(order, agent.latest) ? latest : agent.latest }
    : { latest, definition: null, pause: null, running: 0, queued: 0, steering: 0 };

  switch (read.kind) {
    case "created":
    case "updated":
    case "deleted":
      if (isLater(order, next.definition)) {
        next = {
          ...next,
          definition: { ...order, definition: read.kind === "deleted" ? null : read.definition },
        };
      }
      break;
    case "stopped":
    case "resumed":
      if (isLater(order, next.pause)) {
        next = { ...next, pause: { ...order, paused: read.kind === "stopped" } };
      }
      break;
    case "started":
    case "answered":
    case "cut-off":
    case "failed":
    case "queued":
    case "dispatched":
    case "dropped":
      break;
  }

  if (piAgentEventRequestId(read) === null) {
    return { agent: next, request };
  }
  const before = request ?? NO_REQUEST;
  const after = requestAfter(before, read);
  const [counted, uncounted] = [requestCounts(after), requestCounts(before)];
  return {
    agent: {
      ...next,
      running: next.running + counted.running - uncounted.running,
      queued: next.queued + counted.queued - uncounted.queued,
      steering: next.steering + counted.steering - uncounted.steering,
    },
    request: after,
  };
}

/**
 * The agent people see: a built-in agent, or one whose latest definition event defines it, which
 * takes the place of a built-in agent of the same name; null for any other agent.
 */
export function piAgentRecord(agentName: string, agent: PiAgentState | null): PiAgentRecord | null {
  const defined = agent?.definition?.definition ?? null;
  const definition =
    defined ??
    BUILT_IN_PI_AGENT_DEFINITIONS.find((builtIn) => builtIn.agentName === agentName) ??
    null;
  if (!definition) {
    return null;
  }
  const latestKind = agent?.latest.kind ?? null;
  const answering = (agent?.running ?? 0) > 0;
  const paused = agent?.pause?.paused ?? false;
  return {
    agentName,
    definition,
    builtIn: defined === null,
    latestKind,
    latestAt: agent?.latest.occurredAt ?? null,
    answering,
    queued: agent?.queued ?? 0,
    steering: agent?.steering ?? 0,
    paused,
    displayName: formatPiAgentName(agentName),
    activity:
      latestKind === null
        ? "No recorded activity"
        : answering
          ? "Answering"
          : paused
            ? "Stopped"
            : activityLabels[latestKind],
  };
}

/** The scope's agents: Backoffice's built-in agents, and those their events define. */
function currentPiAgents(events: readonly StoredPiEvent[]): PiAgentRecord[] {
  const agents = new Map<string, PiAgentState>();
  const requests = new Map<string, PiAgentRequestState>();
  for (const event of events) {
    const read = readPiAgentEvent(event);
    if (!read) {
      continue;
    }
    const requestId = piAgentEventRequestId(read);
    const requestKey = requestId === null ? null : piAgentRequestKey(read.agentName, requestId);
    const applied = applyPiAgentEvent(
      agents.get(read.agentName) ?? null,
      requestKey === null ? null : (requests.get(requestKey) ?? null),
      read,
      event,
    );
    agents.set(read.agentName, applied.agent);
    if (requestKey !== null && applied.request) {
      requests.set(requestKey, applied.request);
    }
  }

  const names = new Set([
    ...BUILT_IN_PI_AGENT_DEFINITIONS.map(({ agentName }) => agentName),
    ...agents.keys(),
  ]);
  return [...names].flatMap((agentName) => {
    const record = piAgentRecord(agentName, agents.get(agentName) ?? null);
    return record ? [record] : [];
  });
}

/** Names a request of one agent; request IDs are compared per agent. */
export function piAgentRequestKey(agentName: string, requestId: string): string {
  return JSON.stringify([agentName, requestId]);
}

const activityLabels: Record<PiAgentActivityKind, string> = {
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
};

/** The turn an event ended, or null for any other event. */
export function piAgentTurnEndedBy(
  event: { id: string; occurredAt: Date },
  read: PiAgentEvent | null,
): PiAgentTurnRecord | null {
  return read?.kind === "answered" || read?.kind === "cut-off" || read?.kind === "failed"
    ? { id: event.id, agentName: read.agentName, outcome: read.kind, endedAt: event.occurredAt }
    : null;
}

function endedPiAgentTurns(events: readonly StoredPiEvent[]): PiAgentTurnRecord[] {
  return events.flatMap((event) => {
    const turn = piAgentTurnEndedBy(event, readPiAgentEvent(event));
    return turn ? [turn] : [];
  });
}

/** The scope's agents and the turns they ended, as its `pi` events record them. */
export function createPiAgentCollections(collections: Pick<AutomationTableCollections, "events">): {
  agents: Collection<PiAgentRecord, string>;
  agentTurns: Collection<PiAgentTurnRecord, string>;
} {
  const events = createLiveQueryCollection({
    query: (query) =>
      query
        .from({ event: collections.events })
        .where(({ event }) => eq(event.source, PI_AUTOMATION_SOURCE))
        .select(({ event }) => ({
          id: event.id,
          source: event.source,
          eventType: event.eventType,
          payload: event.payload,
          subject: event.subject,
          occurredAt: event.occurredAt,
          createdAt: event.createdAt,
        })),
  });
  return {
    agents: createDerivedCollection({
      source: events,
      getKey: (agent) => agent.agentName,
      derive: currentPiAgents,
    }),
    agentTurns: createDerivedCollection({
      source: events,
      getKey: (turn) => turn.id,
      derive: endedPiAgentTurns,
    }),
  };
}
