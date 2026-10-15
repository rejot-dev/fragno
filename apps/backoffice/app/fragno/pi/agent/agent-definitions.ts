import {
  piAgentPermissionGrantRequirements,
  type PiAgentDefinition,
} from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import type { PiAvailableModel } from "./pi-agent-contract";

/** Defined by Backoffice in every scope; a scope cannot create, replace, or delete them. */
export const BUILT_IN_PI_AGENT_DEFINITIONS: readonly PiAgentDefinition[] = [
  {
    agentName: "assistant",
    description:
      "General-purpose Backoffice assistant that works with everything the person prompting it may use.",
    model: null,
    permissions: ["*"],
    instructions: "",
    managedBy: { kind: "built-in" },
  },
];

export function builtInPiAgentDefinition(agentName: string): PiAgentDefinition | null {
  return BUILT_IN_PI_AGENT_DEFINITIONS.find((agent) => agent.agentName === agentName) ?? null;
}

/** Grants that no longer name a permission grant nothing, which only narrows the agent. */
export function expandPiAgentPermissions(
  grants: readonly string[],
): BackofficePermissionRequirement[] {
  return [...new Set(grants.flatMap(piAgentPermissionGrantRequirements))];
}

/** A definition without a model uses the first available model, which is the preference order. */
export function resolvePiAgentModel(
  definition: PiAgentDefinition,
  availableModels: readonly PiAvailableModel[],
): PiAvailableModel | null {
  const requested = definition.model;
  if (requested === null) {
    return availableModels[0] ?? null;
  }
  const separator = requested.indexOf("/");
  const provider = requested.slice(0, separator);
  const modelId = requested.slice(separator + 1);
  return (
    availableModels.find((model) => model.provider === provider && model.modelId === modelId) ??
    null
  );
}
