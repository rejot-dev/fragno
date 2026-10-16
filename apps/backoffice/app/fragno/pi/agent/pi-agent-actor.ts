import type { AutomationActors } from "@fragno-dev/backoffice-api/v0/automation";

/** The delegate that narrows every turn of one agent to its definition's permissions. */
export function piAgentActor(agentName: string): AutomationActors["delegation"][number] {
  return { scope: "internal", type: "pi-agent", id: agentName, role: "assistant" };
}
