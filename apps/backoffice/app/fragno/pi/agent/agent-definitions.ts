import {
  piAgentPermissionGrantRequirements,
  type PiAgentDefinition,
} from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import type { PiAgentModelChoice, PiAgentTurn, PiAvailableModel } from "./pi-agent-contract";

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

/** Defined agents run their definition's model at this effort. */
export const PI_DEFINED_AGENT_THINKING_LEVEL = "low";

export function piAgentModelRef(model: Pick<PiAvailableModel, "provider" | "modelId">): string {
  return `${model.provider}/${model.modelId}`;
}

function findAvailableModel(
  model: Pick<PiAvailableModel, "provider" | "modelId">,
  availableModels: readonly PiAvailableModel[],
): PiAvailableModel | null {
  return (
    availableModels.find((available) => piAgentModelRef(available) === piAgentModelRef(model)) ??
    null
  );
}

/**
 * A new built-in agent conversation starts on GPT-6.1 Sol at medium, or on the first available
 * model where Sol is not available, as without an OpenAI key.
 */
export function piBuiltInAgentDefaultModel(
  availableModels: readonly PiAvailableModel[],
): PiAgentModelChoice | null {
  const model =
    findAvailableModel({ provider: "openai", modelId: "gpt-6.1-sol" }, availableModels) ??
    availableModels[0];
  return model
    ? { provider: model.provider, modelId: model.modelId, thinkingLevel: "medium" }
    : null;
}

/**
 * The model a prompt's turn runs with. Only built-in agents choose per prompt, among the available
 * models and the efforts each supports. A prompt that does not choose keeps the conversation's
 * model, and the first one starts it on the default. A defined agent's definition names its model,
 * which admission reads.
 */
export function piPromptModel(
  definition: PiAgentDefinition,
  chosen: PiAgentModelChoice | null,
  provisioned: boolean,
  availableModels: readonly PiAvailableModel[],
):
  | { type: "model"; model: PiAgentModelChoice | null }
  | {
      type: "error";
      status: 400;
      code: "MODEL_NOT_CHOOSABLE" | "MODEL_UNAVAILABLE";
      message: string;
    } {
  const builtIn = definition.managedBy?.kind === "built-in";
  if (!chosen) {
    return {
      type: "model",
      model: builtIn && !provisioned ? piBuiltInAgentDefaultModel(availableModels) : null,
    };
  }
  if (!builtIn) {
    return {
      type: "error",
      status: 400,
      code: "MODEL_NOT_CHOOSABLE",
      message: `Pi agent '${definition.agentName}' runs the model its definition names.`,
    };
  }
  const model = findAvailableModel(chosen, availableModels);
  if (!model || !model.thinkingLevels.includes(chosen.thinkingLevel)) {
    return {
      type: "error",
      status: 400,
      code: "MODEL_UNAVAILABLE",
      message: model
        ? `${model.label} does not support reasoning effort ${chosen.thinkingLevel}.`
        : `Pi model ${piAgentModelRef(chosen)} is not available.`,
    };
  }
  return { type: "model", model: chosen };
}

/** Grants that no longer name a permission grant nothing, which only narrows the agent. */
function expandPiAgentPermissions(grants: readonly string[]): BackofficePermissionRequirement[] {
  return [...new Set(grants.flatMap(piAgentPermissionGrantRequirements))];
}

/**
 * A built-in agent runs the model its prompt chose, which null leaves as the conversation's. A
 * defined agent runs its definition's, where none means the first available model, which is the
 * preference order.
 */
function resolvePiAgentModel(
  definition: PiAgentDefinition,
  chosen: PiAgentModelChoice | null,
  availableModels: readonly PiAvailableModel[],
): { type: "model"; model: PiAgentModelChoice | null } | { type: "unavailable" } {
  if (definition.managedBy?.kind === "built-in") {
    if (availableModels.length === 0 || (chosen && !findAvailableModel(chosen, availableModels))) {
      return { type: "unavailable" };
    }
    return { type: "model", model: chosen };
  }
  const requested = definition.model;
  const model =
    requested === null
      ? availableModels[0]
      : availableModels.find((available) => piAgentModelRef(available) === requested);
  return model
    ? {
        type: "model",
        model: {
          provider: model.provider,
          modelId: model.modelId,
          thinkingLevel: PI_DEFINED_AGENT_THINKING_LEVEL,
        },
      }
    : { type: "unavailable" };
}

export type PiAgentAdmission =
  | { type: "turn"; turn: PiAgentTurn }
  | {
      type: "error";
      status: 400 | 404;
      code: "AGENT_NOT_FOUND" | "MODEL_UNAVAILABLE";
      message: string;
    };

/**
 * A turn runs with its agent's definition as it is when the turn is admitted, and the model its
 * prompt chose, if any.
 */
export function admitPiAgentTurn(
  definition: PiAgentDefinition | null,
  agentName: string,
  provenance: Pick<PiAgentTurn, "actors" | "scopeRestriction">,
  availableModels: readonly PiAvailableModel[],
  chosen: PiAgentModelChoice | null,
): PiAgentAdmission {
  if (!definition) {
    return {
      type: "error",
      status: 404,
      code: "AGENT_NOT_FOUND",
      message: `Pi agent '${agentName}' is not defined.`,
    };
  }
  const model = resolvePiAgentModel(definition, chosen, availableModels);
  if (model.type === "unavailable") {
    const requested = chosen ? piAgentModelRef(chosen) : definition.model;
    return {
      type: "error",
      status: 400,
      code: "MODEL_UNAVAILABLE",
      message: requested
        ? `Pi model ${requested} is not available.`
        : "No configured Pi model is available.",
    };
  }
  return {
    type: "turn",
    turn: {
      ...provenance,
      agent: {
        model: model.model,
        instructions: definition.instructions,
        permissions: expandPiAgentPermissions(definition.permissions),
      },
    },
  };
}
