import {
  piAgentPermissionGrantRequirements,
  type PiAgentDefinition,
} from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { createBackofficeServiceExecution } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createBackofficeStaticFileCollection } from "@/files/content/static";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";
import {
  createBackofficeSystemStateBackend,
  type BackofficeStateBackend,
} from "@/fragno/codemode/state-backend";
import { createCodemodeStaticArtifactsResolver } from "@/fragno/codemode/static-codemode-artifacts";
import { isUploadNotConfiguredError } from "@/fragno/pi/extensions/backoffice/skills";

import type { PiAvailableModel } from "./pi-agent-contract";

/** Defined by Backoffice in every scope; a scope cannot create, replace, or delete them. */
export const BUILT_IN_PI_AGENT_DEFINITIONS: readonly PiAgentDefinition[] = [
  {
    agentName: "assistant",
    description:
      "General-purpose Backoffice assistant that works with everything the person prompting it may use.",
    model: null,
    permissions: ["*"],
    instructionsPath: null,
    managedBy: { kind: "built-in" },
  },
];

export function builtInPiAgentDefinition(agentName: string): PiAgentDefinition | null {
  return BUILT_IN_PI_AGENT_DEFINITIONS.find((agent) => agent.agentName === agentName) ?? null;
}

export type PiAgentInstructionFiles = Pick<BackofficeStateBackend, "readFile" | "exists">;

/**
 * Instructions are scope configuration rather than a member's data, so the manager reads them as
 * itself. Runtimes without Upload can only read static files.
 */
export function createPiAgentInstructionFiles(input: {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  scope: BackofficeContextScope;
}): PiAgentInstructionFiles {
  const execution = createBackofficeServiceExecution({
    scope: input.scope,
    service: { type: "object", id: "pi-manager" },
  });
  if (input.scope.kind !== "system" && input.runtime.config.bindings.upload) {
    return createRuntimeStateBackend({ runtime: input.runtime, kernel: input.kernel, execution });
  }
  return createBackofficeSystemStateBackend({
    staticFileCollection: createBackofficeStaticFileCollection(
      createCodemodeStaticArtifactsResolver({ objects: input.runtime.objects, execution }),
    ),
  });
}

export async function piAgentInstructionsExist(
  files: PiAgentInstructionFiles,
  path: string,
): Promise<boolean> {
  try {
    return await files.exists(path);
  } catch (error) {
    if (isUploadNotConfiguredError(error)) {
      return false;
    }
    throw error;
  }
}

/** Null when the definition names an instructions file that no longer exists. */
export async function readPiAgentInstructions(
  files: PiAgentInstructionFiles,
  definition: PiAgentDefinition,
): Promise<string | null> {
  if (definition.instructionsPath === null) {
    return "";
  }
  if (!(await piAgentInstructionsExist(files, definition.instructionsPath))) {
    return null;
  }
  return await files.readFile(definition.instructionsPath);
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
