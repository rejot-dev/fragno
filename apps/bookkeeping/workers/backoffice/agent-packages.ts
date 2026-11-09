import {
  BackofficeApiRequestError,
  BackofficeApiUnreachableError,
} from "@fragno-dev/backoffice-api/v0/client";

import { AGENT_PACKAGES, agentPackageListingId, type AgentPackageName } from "./agents";
import { connectWithAppToken, isBackofficeUnavailable, requestAppToken } from "./client";

/** Where each agent package is installed in its project, beside the files people keep there. */
const AGENT_PACKAGE_ROOT = "/workspace/bookkeeping";

/**
 * An install Bookkeeping asked for and has not seen finish: the version, and Backoffice's run, null
 * until Bookkeeping hears Backoffice's answer to starting it.
 */
export type AgentPackageInstall = { version: string; workflowInstanceId: string | null };

/** A project Bookkeeping prompts one of its agents in, and the install in it not seen finishing. */
export type AgentPackagePlacement = {
  package: AgentPackageName;
  orgId: string;
  projectId: string;
  installing: AgentPackageInstall | null;
};

/**
 * Where a project's package stands after one step toward the version Bookkeeping ships: a version
 * installed, which may be one Bookkeeping no longer ships; still installing; its install failed, as
 * when members defined an agent of the package's name, so the next step starts another; or no
 * further, as when Backoffice could not be reached.
 */
export type AgentPackageStep =
  | { kind: "installed"; version: string }
  | { kind: "installing"; install: AgentPackageInstall }
  | { kind: "install-failed" }
  | { kind: "failed" };

/**
 * Takes one step toward the shipped version in each project, one project at a time, with one app
 * token: Backoffice rate-limits issuing tokens. `record` keeps each step of the placement at that
 * index as it is taken, and an install before Bookkeeping asks for it, so one whose answer never
 * arrives is still followed. Each project's step is its own: one that fails for a reason that may
 * pass is `failed`, and the rest still take theirs. Throws on any other failure, such as a
 * misconfigured OAuth client, which retrying does not fix.
 */
export async function advanceAgentPackages(
  env: CloudflareEnv,
  placements: readonly AgentPackagePlacement[],
  record: (index: number, step: AgentPackageStep) => void,
): Promise<void> {
  if (placements.length === 0) {
    return;
  }
  let appToken: string;
  try {
    appToken = await requestAppToken(env);
  } catch (error) {
    if (!mayPass(error)) {
      throw error;
    }
    console.warn("Bookkeeping could not install its agents' packages yet.", error);
    for (const index of placements.keys()) {
      record(index, { kind: "failed" });
    }
    return;
  }
  for (const [index, placement] of placements.entries()) {
    const recordStep = (step: AgentPackageStep) => {
      record(index, step);
    };
    try {
      // One at a time, so a sweep after a deploy does not burst Backoffice.
      // oxlint-disable-next-line no-await-in-loop
      recordStep(await advanceAgentPackage(env, appToken, placement, recordStep));
    } catch (error) {
      if (!mayPass(error)) {
        throw error;
      }
      console.warn("Bookkeeping could not install an agent's package yet.", error);
      recordStep({ kind: "failed" });
    }
  }
}

/**
 * Whether a step failed for a reason that may pass: Backoffice could not be reached or was busy, or
 * refused for something about the project or the Marketplace that may change, as when the project's
 * owners have not granted Bookkeeping `packages.install` yet or the shipped version is not published
 * yet. A request Backoffice rejects as invalid, or a credential it does not accept, is Bookkeeping's
 * mistake, which retrying does not fix.
 */
function mayPass(error: unknown): boolean {
  if (error instanceof BackofficeApiUnreachableError || isBackofficeUnavailable(error)) {
    return true;
  }
  return (
    error instanceof BackofficeApiRequestError &&
    error.code !== "invalid_request" &&
    error.code !== "authentication_failed"
  );
}

/**
 * Takes one step toward installing the shipped version of the project's package, as Bookkeeping's
 * installation there: follows the install it started until it finishes, whatever its version, and
 * then starts the shipped version's when that is not what it installed. Backoffice would run
 * another version's install beside it, and whichever read the installation last would win, so an
 * older install could undo a newer one.
 */
async function advanceAgentPackage(
  env: CloudflareEnv,
  appToken: string,
  placement: AgentPackagePlacement,
  record: (step: AgentPackageStep) => void,
): Promise<AgentPackageStep> {
  const agentPackage = AGENT_PACKAGES[placement.package];
  const scope = {
    kind: "project" as const,
    owner: { kind: "org" as const, orgId: placement.orgId, jurisdiction: null },
    projectId: placement.projectId,
  };
  const backoffice = await connectWithAppToken(env, appToken, scope);
  if (!backoffice) {
    return { kind: "failed" };
  }
  // Backoffice runs one install of a version in a project at a time: asking for it again while it
  // runs answers with that run.
  const install = async (version: string): Promise<AgentPackageStep> => {
    record({ kind: "installing", install: { version, workflowInstanceId: null } });
    let started;
    try {
      started = await backoffice.call(scope, "packages.install", {
        listingId: agentPackageListingId(agentPackage),
        version,
        installationRoot: AGENT_PACKAGE_ROOT,
        // The package's agent lists permissions, but they only narrow the turns of whoever prompts
        // it.
        permissions: [],
        visibility: "app",
      });
    } catch (error) {
      // Backoffice refused it, so it started no install, as for a version not published yet:
      // nothing is left to follow, and the next step installs the shipped version.
      if (error instanceof BackofficeApiRequestError && error.code !== null && mayPass(error)) {
        console.warn(
          `Bookkeeping could not install ${agentPackageListingId(agentPackage)}@${version} in project ${placement.projectId}.`,
          error.message,
        );
        return { kind: "install-failed" };
      }
      throw error;
    }
    return {
      kind: "installing",
      install: { version, workflowInstanceId: started.workflowInstanceId },
    };
  };
  const { installing } = placement;
  if (installing?.workflowInstanceId === null) {
    // Bookkeeping never heard whether this install started. Asking for it again answers with its
    // run, starting it if it never did, even when it is no longer the shipped version.
    return await install(installing.version);
  }
  if (installing) {
    const status = await backoffice.call(scope, "packages.status", {
      workflowInstanceId: installing.workflowInstanceId,
      workflowScope: scope.owner,
    });
    if (status?.status === "complete") {
      // The next step installs the shipped version, if this is no longer it.
      return { kind: "installed", version: installing.version };
    }
    if (status === null) {
      // This workspace has no such run, so it never started; nothing is installing.
    } else if (status.status === "errored" || status.status === "terminated") {
      console.warn(
        `Bookkeeping could not install ${agentPackageListingId(agentPackage)}@${installing.version} in project ${placement.projectId}.`,
        status.status === "errored" ? status.error.message : "Its install was terminated.",
      );
      if (installing.version === agentPackage.version) {
        return { kind: "install-failed" };
      }
    } else {
      return { kind: "installing", install: installing };
    }
  }
  return await install(agentPackage.version);
}
