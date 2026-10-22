import { formatRelativeTime } from "@fragno-private/design-system/relative-time";

import { gte, type InitialQueryBuilder } from "@tanstack/react-db";

import type { AutomationCollections } from "@/fragno/automation/tanstack/collections";
import type { PiAgentActivityKind } from "@/fragno/backoffice-capabilities/capabilities/pi";
import type { PiAgentRecord } from "@/fragno/pi/agent/pi-agent-records";

import { dashboardBucketIndex } from "../dashboard/overview";

/** An agent with the turns it ended in each hourly bucket of the window. */
export type PiAgentListing = PiAgentRecord & { turnsPerBucket: number[] };

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

/** Every turn ended since the window's first bucket began. */
export function piAgentTurnsQuery(
  query: InitialQueryBuilder,
  collections: Pick<AutomationCollections, "agentTurns">,
  since: Date,
) {
  return query
    .from({ turn: collections.agentTurns })
    .where(({ turn }) => gte(turn.endedAt, since))
    .select(({ turn }) => ({ agentName: turn.agentName, endedAt: turn.endedAt }));
}

/** Each agent with its turns counted per bucket, from turns that ended within the window. */
export function piAgentListings(
  agents: readonly PiAgentRecord[],
  turns: readonly { agentName: string; endedAt: Date }[],
  bucketStarts: readonly number[],
): PiAgentListing[] {
  const counts = new Map<string, number[]>();
  for (const turn of turns) {
    const perBucket = counts.get(turn.agentName) ?? bucketStarts.map(() => 0);
    perBucket[dashboardBucketIndex(bucketStarts, turn.endedAt)] += 1;
    counts.set(turn.agentName, perBucket);
  }
  return agents.map((agent) => ({
    ...agent,
    turnsPerBucket: counts.get(agent.agentName) ?? bucketStarts.map(() => 0),
  }));
}

/** What the agent is doing, or else what it did last. */
export function describePiAgentActivity(agent: PiAgentRecord, now: number): string {
  if (agent.latestKind === null || agent.latestAt === null) {
    return "No recorded activity";
  }
  return agent.answering
    ? "Answering"
    : agent.paused
      ? "Stopped"
      : `${activityLabels[agent.latestKind]} ${formatRelativeTime(agent.latestAt, now)}`;
}

/**
 * The agent's queue as one status: what waits, and whether it waits on a stop; null when nothing
 * waits.
 */
export function piAgentQueueStatus({
  queued,
  steering,
  paused,
}: Pick<PiAgentRecord, "queued" | "steering" | "paused">): {
  label: string;
  tone: "waiting" | "info";
} | null {
  const parts = [
    ...(steering > 0 ? [`${steering} steering`] : []),
    ...(queued > 0 ? [`${queued} queued`] : []),
  ];
  if (parts.length === 0) {
    return null;
  }
  // Steers join the running turn, so only queued work waits on a stop.
  return paused && queued > 0
    ? { label: `${parts.join(" · ")} · paused`, tone: "waiting" }
    : { label: parts.join(" · "), tone: "info" };
}
