import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";

import { createLiveQueryCollection, eq, type Collection } from "@tanstack/react-db";

import type { AutomationTableCollections } from "@/fragno/automation/tanstack/collections";
import {
  PI_AUTOMATION_SOURCE,
  readPiAgentEvent,
  type PiAgentActivityKind,
} from "@/fragno/backoffice-capabilities/capabilities/pi";
import { createDerivedCollection } from "@/fragno/tanstack/derived-collection";

import { BUILT_IN_PI_AGENT_DEFINITIONS } from "./agent-definitions";

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
};

/** A turn that ended, keyed by the event that ended it. */
export type PiAgentTurnRecord = {
  id: string;
  agentName: string;
  outcome: "answered" | "cut-off" | "failed";
  endedAt: Date;
};

/** Requests by what their events record of them, and when the agent was last stopped or resumed. */
type AgentEvents = {
  latest: { kind: PiAgentActivityKind; at: StoredPiEvent };
  started: Set<string>;
  ended: Set<string>;
  /** Waiting requests, by whether each is a steer. */
  waiting: Map<string, { steer: boolean }>;
  /** Requests whose wait ended: dispatched, dropped, or started or ended by Pi. */
  dequeued: Set<string>;
  pause: { paused: boolean; at: StoredPiEvent } | null;
};

/** Changes made in the same instant are ordered by when they were stored. */
function isLater(event: StoredPiEvent, than: StoredPiEvent | undefined) {
  return (
    !than ||
    event.occurredAt > than.occurredAt ||
    (event.occurredAt.getTime() === than.occurredAt.getTime() && event.createdAt > than.createdAt)
  );
}

/**
 * The scope's agents: Backoffice's built-in agents, and those whose latest definition event
 * defines them. Events are matched by request ID, not order, so a turn whose start was recorded
 * after its end does not read as running.
 */
function currentPiAgents(events: readonly StoredPiEvent[]): PiAgentRecord[] {
  const definitions = new Map<
    string,
    { definition: PiAgentDefinition | null; at: StoredPiEvent }
  >();
  const records = new Map<string, AgentEvents>();
  for (const event of events) {
    const read = readPiAgentEvent(event);
    if (!read) {
      continue;
    }
    let record = records.get(read.agentName);
    if (!record) {
      record = {
        latest: { kind: read.kind, at: event },
        started: new Set(),
        ended: new Set(),
        waiting: new Map(),
        dequeued: new Set(),
        pause: null,
      };
      records.set(read.agentName, record);
    } else if (isLater(event, record.latest.at)) {
      record.latest = { kind: read.kind, at: event };
    }

    switch (read.kind) {
      case "created":
      case "updated":
      case "deleted":
        if (isLater(event, definitions.get(read.agentName)?.at)) {
          definitions.set(read.agentName, {
            definition: read.kind === "deleted" ? null : read.definition,
            at: event,
          });
        }
        break;
      case "stopped":
      case "resumed":
        if (isLater(event, record.pause?.at)) {
          record.pause = { paused: read.kind === "stopped", at: event };
        }
        break;
      case "started":
        record.started.add(read.requestId);
        record.dequeued.add(read.requestId);
        break;
      case "answered":
      case "cut-off":
      case "failed":
        record.ended.add(read.requestId);
        // A steer its turn's stop cut off before Pi placed it ends without starting.
        record.dequeued.add(read.requestId);
        break;
      case "queued":
        record.waiting.set(read.requestId, { steer: read.steer });
        break;
      case "dispatched":
      case "dropped":
        record.dequeued.add(read.requestId);
        break;
    }
  }

  const defined = [...definitions.values()].flatMap(({ definition }) =>
    definition ? [definition] : [],
  );
  return [
    ...BUILT_IN_PI_AGENT_DEFINITIONS.map((definition) => ({ definition, builtIn: true })),
    ...defined.map((definition) => ({ definition, builtIn: false })),
  ].map(({ definition, builtIn }) => {
    const record = records.get(definition.agentName);
    const stillWaiting = record
      ? [...record.waiting].filter(([requestId]) => !record.dequeued.has(requestId))
      : [];
    return {
      agentName: definition.agentName,
      definition,
      builtIn,
      latestKind: record?.latest.kind ?? null,
      latestAt: record?.latest.at.occurredAt ?? null,
      answering: record
        ? [...record.started].some((requestId) => !record.ended.has(requestId))
        : false,
      queued: stillWaiting.filter(([, { steer }]) => !steer).length,
      steering: stillWaiting.filter(([, { steer }]) => steer).length,
      paused: record?.pause?.paused ?? false,
    };
  });
}

function endedPiAgentTurns(events: readonly StoredPiEvent[]): PiAgentTurnRecord[] {
  return events.flatMap((event) => {
    const read = readPiAgentEvent(event);
    return read?.kind === "answered" || read?.kind === "cut-off" || read?.kind === "failed"
      ? [{ id: event.id, agentName: read.agentName, outcome: read.kind, endedAt: event.occurredAt }]
      : [];
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
