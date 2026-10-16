import type { AutomationActors } from "@fragno-dev/backoffice-api/v0/automation";
import {
  type BackofficeContextScope,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

/**
 * The delegate that narrows every turn of one agent to its definition's permissions. Agents of
 * different scopes can share a name, so its ID is the agent's scope and then its name.
 */
export function piAgentActor(
  scope: BackofficeContextScope,
  agentName: string,
): AutomationActors["delegation"][number] {
  return {
    scope: "internal",
    type: "pi-agent",
    id: `${backofficeScopePathSegment(scope)}/${agentName}`,
    role: "assistant",
  };
}

/** The agent name of a `piAgentActor`; scope segments encode `/`, so the name follows the last. */
export function piAgentActorName(actor: Pick<AutomationActors["delegation"][number], "id">) {
  return actor.id.slice(actor.id.lastIndexOf("/") + 1);
}
