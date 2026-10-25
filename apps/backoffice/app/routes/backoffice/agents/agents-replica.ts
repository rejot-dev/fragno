import type { LofiSqliteReader } from "@fragno-dev/lofi/sqlite";

import { readPiAgents, readPiAgentTurns } from "@/fragno/automation/lofi/views";

import { piAgentListings, type PiAgentListing } from "./agent-activity";

/**
 * The Agents directory: the scope's agents, built-in agents first and then by name, each with the
 * turns it ended in the hourly buckets that begin at `bucketStarts`.
 */
export function readPiAgentDirectory(
  reader: LofiSqliteReader,
  { bucketStarts }: { bucketStarts: number[] },
): PiAgentListing[] {
  const agents = readPiAgents(reader).sort(
    (left, right) =>
      Number(right.builtIn) - Number(left.builtIn) ||
      (left.agentName < right.agentName ? -1 : left.agentName > right.agentName ? 1 : 0),
  );
  const since = bucketStarts[0];
  const turns = since === undefined ? [] : readPiAgentTurns(reader, new Date(since));
  return piAgentListings(agents, turns, bucketStarts);
}
