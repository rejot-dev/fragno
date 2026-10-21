import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";

import { eq, type InitialQueryBuilder } from "@tanstack/react-db";

import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";
import {
  PI_AUTOMATION_SOURCE,
  readPiAgentEvent,
  type PiAgentActivityKind,
} from "@/fragno/backoffice-capabilities/capabilities/pi";
import { BUILT_IN_PI_AGENT_DEFINITIONS } from "@/fragno/pi/agent/agent-definitions";

import { formatRelativeTime } from "../automations/formatting";
import { dashboardBucketIndex } from "../dashboard/overview";

type StoredPiEvent = {
  source: string;
  eventType: string;
  payload: unknown;
  subject: unknown;
  occurredAt: Date;
  createdAt: Date;
};

/** What a scope's `pi` events say an agent did and is doing, with ended turns per hourly bucket. */
export type PiAgentActivity = {
  latest: { kind: PiAgentActivityKind; occurredAt: Date };
  /** Whether a turn has started that has not ended. */
  answering: boolean;
  /** What waits for the agent: queued for a turn of its own, or steering the running turn. */
  waiting: { queued: number; steering: number };
  /** Whether the agent was stopped and not resumed since. */
  paused: boolean;
  turns: number;
  turnsPerBucket: number[];
};

/** An agent of the scope, as its `pi` events record it, and what it did. */
export type PiAgentListing = {
  definition: PiAgentDefinition;
  /** Null for an agent its events record nothing about, such as a built-in agent never prompted. */
  activity: PiAgentActivity | null;
};

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

/** Requests by what their events record of them, and when the agent was last stopped or resumed. */
type AgentRecord = {
  latest: { kind: PiAgentActivityKind; at: StoredPiEvent };
  started: Set<string>;
  ended: Set<string>;
  /** Waiting requests, by whether each is a steer. */
  waiting: Map<string, { steer: boolean }>;
  /** Requests whose wait ended: dispatched, dropped, or started or ended by Pi. */
  dequeued: Set<string>;
  pause: { paused: boolean; at: StoredPiEvent } | null;
  turns: number;
  turnsPerBucket: number[];
};

/** Every `pi` event ever recorded in the scope; together they are its agents. */
export function piAgentEventsQuery(
  query: InitialQueryBuilder,
  collections: Pick<AutomationCollections, "events">,
) {
  return query
    .from({ event: collections.events })
    .where(({ event }) => eq(event.source, PI_AUTOMATION_SOURCE))
    .select(({ event }) => ({
      source: event.source,
      eventType: event.eventType,
      payload: event.payload,
      subject: event.subject,
      occurredAt: event.occurredAt,
      createdAt: event.createdAt,
    }));
}

/** Changes made in the same instant are ordered by when they were stored. */
function isLater(event: StoredPiEvent, than: StoredPiEvent | undefined) {
  return (
    !than ||
    event.occurredAt > than.occurredAt ||
    (event.occurredAt.getTime() === than.occurredAt.getTime() && event.createdAt > than.createdAt)
  );
}

function waitingWork({ waiting, dequeued }: AgentRecord): PiAgentActivity["waiting"] {
  const still = [...waiting].filter(([requestId]) => !dequeued.has(requestId));
  return {
    queued: still.filter(([, { steer }]) => !steer).length,
    steering: still.filter(([, { steer }]) => steer).length,
  };
}

/**
 * The scope's agents: Backoffice's built-in agents, then those whose latest definition event
 * defines them, by name. Events are matched by request ID, not order, so a turn whose start was
 * recorded after its end does not read as running. Ended turns before the first bucket count only
 * toward `latest`.
 */
export function projectPiAgents({
  events,
  bucketStarts,
}: {
  events: readonly StoredPiEvent[];
  bucketStarts: readonly number[];
}): PiAgentListing[] {
  const windowStart = bucketStarts[0] ?? Number.POSITIVE_INFINITY;
  const definitions = new Map<
    string,
    { definition: PiAgentDefinition | null; at: StoredPiEvent }
  >();
  const records = new Map<string, AgentRecord>();
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
        turns: 0,
        turnsPerBucket: bucketStarts.map(() => 0),
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
        if (event.occurredAt.getTime() >= windowStart) {
          record.turns += 1;
          record.turnsPerBucket[dashboardBucketIndex(bucketStarts, event.occurredAt)] += 1;
        }
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

  const defined = [...definitions.values()]
    .flatMap(({ definition }) => (definition ? [definition] : []))
    .sort((left, right) => left.agentName.localeCompare(right.agentName));
  return [...BUILT_IN_PI_AGENT_DEFINITIONS, ...defined].map((definition) => {
    const record = records.get(definition.agentName);
    return {
      definition,
      activity: record
        ? {
            latest: { kind: record.latest.kind, occurredAt: record.latest.at.occurredAt },
            answering: [...record.started].some((requestId) => !record.ended.has(requestId)),
            waiting: waitingWork(record),
            paused: record.pause?.paused ?? false,
            turns: record.turns,
            turnsPerBucket: record.turnsPerBucket,
          }
        : null,
    };
  });
}

/** What the agent is doing, or else what it did last. */
export function describePiAgentActivity(activity: PiAgentActivity | null, now: number): string {
  if (!activity) {
    return "No recorded activity";
  }
  return activity.answering
    ? "Answering"
    : activity.paused
      ? "Stopped"
      : `${activityLabels[activity.latest.kind]} ${formatRelativeTime(activity.latest.occurredAt, now)}`;
}

/**
 * The agent's queue as one status: what waits, and whether it waits on a stop; null when nothing
 * waits.
 */
export function piAgentQueueStatus(
  activity: PiAgentActivity | null,
): { label: string; tone: "waiting" | "info" } | null {
  if (!activity) {
    return null;
  }
  const { queued, steering } = activity.waiting;
  const parts = [
    ...(steering > 0 ? [`${steering} steering`] : []),
    ...(queued > 0 ? [`${queued} queued`] : []),
  ];
  if (parts.length === 0) {
    return null;
  }
  // Steers join the running turn, so only queued work waits on a stop.
  return activity.paused && queued > 0
    ? { label: `${parts.join(" · ")} · paused`, tone: "waiting" }
    : { label: parts.join(" · "), tone: "info" };
}
