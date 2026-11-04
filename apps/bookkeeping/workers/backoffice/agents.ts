import { BackofficeApiRequestError } from "@fragno-dev/backoffice-api/v0/client";
import type { PiAgentDefinition, PiAgentDefinitionCreate } from "@fragno-dev/backoffice-api/v0/pi";

import type { InstalledProject } from "./document-shares";

/** Where Bookkeeping keeps the definition it last wrote of one agent, as `definitionFields` gives it. */
export type WrittenDefinition = {
  /** Null when Bookkeeping recorded none. */
  find(): Promise<string | null>;
  record(definition: string): Promise<void>;
};

/** What Bookkeeping writes of a definition and compares, as one string. */
function definitionFields({
  description,
  model,
  permissions,
  instructions,
}: Pick<PiAgentDefinition, "description" | "model" | "permissions" | "instructions">): string {
  return JSON.stringify({ description, model, permissions, instructions });
}

/**
 * Defines one of the agents Bookkeeping keeps in a project as `definition`, so changes to how
 * Bookkeeping asks reach agents set up before them. An agent whose definition differs from the one
 * Bookkeeping last wrote was changed by the project's members in Backoffice, and is theirs to keep.
 */
export async function defineAgent(
  project: InstalledProject,
  definition: PiAgentDefinitionCreate,
  written: WrittenDefinition,
): Promise<void> {
  let stored: PiAgentDefinition;
  try {
    stored = await project.backoffice.call(project.scope, "pi.agent.create", definition);
  } catch (error) {
    if (!(error instanceof BackofficeApiRequestError && error.code === "conflict")) {
      throw error;
    }
    const current = await project.backoffice.call(project.scope, "pi.agent.get", {
      agentName: definition.agentName,
    });
    const recorded = await written.find();
    if (recorded !== null && recorded !== definitionFields(current)) {
      return;
    }
    stored =
      definitionFields(current) === definitionFields(definition)
        ? current
        : await project.backoffice.call(project.scope, "pi.agent.update", definition);
  }
  // As Backoffice stored it, which is what later reads compare.
  await written.record(definitionFields(stored));
}
