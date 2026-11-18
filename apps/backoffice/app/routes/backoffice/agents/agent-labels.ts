import type { PiAgentSteward } from "@fragno-dev/backoffice-api/v0/pi";

import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";

/** Who keeps an agent, as people read it. */
export function describePiAgentSteward(steward: PiAgentSteward): string {
  if (steward.kind === "backoffice") {
    return "Built in";
  }
  return steward.kind === "package"
    ? `Installed by package ${steward.listingId}`
    : "Defined in this workspace";
}

/** Why people cannot write to an agent with a category, as one sentence. */
export function describePiAgentWithCategory(agentName: string): string {
  return `${formatPiAgentName(agentName)} takes work from agents and workflows, not messages.`;
}
