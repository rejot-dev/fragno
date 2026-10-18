import {
  piAgentPermissionGrantRequirements,
  type PiAgentDefinition,
} from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import type { PiAgentTurn, PiAvailableModel } from "./pi-agent-contract";

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
function expandPiAgentPermissions(grants: readonly string[]): BackofficePermissionRequirement[] {
  return [...new Set(grants.flatMap(piAgentPermissionGrantRequirements))];
}

/** A definition without a model uses the first available model, which is the preference order. */
function resolvePiAgentModel(
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

export type PiAgentAdmission =
  | { type: "turn"; turn: PiAgentTurn }
  | {
      type: "error";
      status: 400 | 404;
      code: "AGENT_NOT_FOUND" | "MODEL_UNAVAILABLE";
      message: string;
    };

/** A turn runs with its agent's definition as it is when the turn is admitted. */
export function admitPiAgentTurn(
  definition: PiAgentDefinition | null,
  agentName: string,
  provenance: Pick<PiAgentTurn, "actors" | "scopeRestriction">,
  availableModels: readonly PiAvailableModel[],
): PiAgentAdmission {
  if (!definition) {
    return {
      type: "error",
      status: 404,
      code: "AGENT_NOT_FOUND",
      message: `Pi agent '${agentName}' is not defined.`,
    };
  }
  const model = resolvePiAgentModel(definition, availableModels);
  if (!model) {
    return {
      type: "error",
      status: 400,
      code: "MODEL_UNAVAILABLE",
      message: definition.model
        ? `Pi model ${definition.model} is not available.`
        : "No configured Pi model is available.",
    };
  }
  return {
    type: "turn",
    turn: {
      ...provenance,
      agent: {
        model: { provider: model.provider, modelId: model.modelId },
        instructions: definition.instructions,
        permissions: expandPiAgentPermissions(definition.permissions),
      },
    },
  };
}
