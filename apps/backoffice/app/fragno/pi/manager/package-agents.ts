import type { AutomationActors } from "@fragno-dev/backoffice-api/v0/automation";
import type { PiAgentDefinitionCreate } from "@fragno-dev/backoffice-api/v0/pi";

import type { PackageInstallationOutcome } from "@/fragno/automation/package-installations";
import { AutomationStewardError } from "@/fragno/automation/stewards";

import type { createPiManagerFragment } from "./pi-manager-fragment";

type PiManagerFragment = Pick<
  ReturnType<typeof createPiManagerFragment>,
  "callServices" | "services"
>;

export type PackageAgentsInput = {
  listingId: string;
  agents: readonly PiAgentDefinitionCreate[];
  /** Who installed the package, which the agents' `agent.*` events attribute. */
  actors: AutomationActors;
};

/**
 * Makes a package's agents in this scope match its declaration. Taking over an agent the package
 * doesn't steward is refused, as a value, since installing again can't fix it.
 */
export async function applyPackageAgents(
  fragment: PiManagerFragment,
  { listingId, agents, actors }: PackageAgentsInput,
): Promise<PackageInstallationOutcome> {
  try {
    await fragment.callServices(() =>
      fragment.services.applyPackageAgents(listingId, agents, { actors, scopeRestriction: null }),
    );
    return { ok: true };
  } catch (error) {
    if (error instanceof AutomationStewardError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

/** Deletes a package's agents in this scope, returning their names. */
export async function removePackageAgents(
  fragment: PiManagerFragment,
  { listingId, actors }: { listingId: string; actors: AutomationActors },
): Promise<string[]> {
  return await fragment.callServices(() =>
    fragment.services.removePackageAgents(listingId, { actors, scopeRestriction: null }),
  );
}
