import type { PiAgentDefinition } from "@fragno-dev/backoffice-api/v0/pi";

import { admitPiAgentTurn } from "./agent-definitions";
import type { PiAgentTurn, PiAvailableModel } from "./pi-agent-contract";

/** Who asks for a turn: its actors and scope restriction, which its authority derives from. */
type PiAgentSender = Pick<PiAgentTurn, "actors" | "scopeRestriction">;

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)),
        )
      : nested,
  );
}

/**
 * One sender per turn: work joins a turn, by steering it or sharing it, only when it comes from
 * the turn's sender.
 */
export function mayJoinPiAgentTurn(running: PiAgentSender, joining: PiAgentSender): boolean {
  return (
    canonicalJson([running.actors, running.scopeRestriction]) ===
    canonicalJson([joining.actors, joining.scopeRestriction])
  );
}

/**
 * The turn to run next, by the queue's rules that pick turns (see the Pi README for the others):
 *
 * 1. Oldest first: items are handled in the order they arrived.
 * 2. One sender per turn: items from different senders run in separate turns.
 * 3. Group notifications: notifications waiting from the same sender are handled together.
 * 4. One prompt per turn: each prompt gets its own turn.
 *
 * Admission depends on the agent's definition and models alone, so a head that cannot be admitted
 * means nothing waiting can run.
 */
export function nextPiAgentQueueTurn<
  TItem extends { input: { type: "prompt" | "notification" }; provenance: PiAgentSender },
>(
  queued: readonly TItem[],
  definition: PiAgentDefinition | null,
  agentName: string,
  availableModels: readonly PiAvailableModel[],
):
  | { type: "idle" }
  | { type: "dispatch"; items: [TItem, ...TItem[]]; turn: PiAgentTurn }
  | { type: "drop"; reason: string } {
  const [head, ...waiting] = queued;
  if (!head) {
    return { type: "idle" };
  }
  const admitted = admitPiAgentTurn(definition, agentName, head.provenance, availableModels);
  if (admitted.type === "error") {
    return { type: "drop", reason: admitted.message };
  }
  const grouped =
    head.input.type === "prompt"
      ? []
      : waiting.filter(
          (item) =>
            item.input.type === "notification" &&
            mayJoinPiAgentTurn(head.provenance, item.provenance),
        );
  return { type: "dispatch", items: [head, ...grouped], turn: admitted.turn };
}
