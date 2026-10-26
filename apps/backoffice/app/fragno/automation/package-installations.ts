import {
  automationRouteActionAuthority,
  type AutomationActors,
  type AutomationRouteCreateInput,
  type AutomationRouteSteward,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { PackageInstallation } from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  backofficeContextScopesEqual,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z, ZodError } from "zod";

import type { createAutomationFragment } from "./index";
import { isAutomationScheduleError } from "./route-triggers";
import { AutomationRouteAuthorityError } from "./routing";
import { AutomationRouteStewardError } from "./routing-storage-runtime";

type AutomationFragment = Pick<
  ReturnType<typeof createAutomationFragment>,
  "callServices" | "services"
>;

/** A refusal to install that retrying can't fix. */
export class PackageInstallationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageInstallationError";
  }
}

/** Installing again replaces an installation only in its own folder, from its own Marketplace. */
export function assertPackageInstallationReplaceable(
  existing: PackageInstallation | null,
  next: { listingId: string; marketplace: BackofficeContextScope; installationRoot: string },
) {
  if (!existing) {
    return;
  }
  if (existing.installationRoot !== next.installationRoot) {
    throw new PackageInstallationError(
      `Package '${next.listingId}' is already installed at '${existing.installationRoot}'. Install it there, or uninstall it first.`,
    );
  }
  if (!backofficeContextScopesEqual(existing.marketplace, next.marketplace)) {
    throw new PackageInstallationError(
      `Package '${next.listingId}' is already installed from another Marketplace. Uninstall it first.`,
    );
  }
}

/**
 * A package's routes may only grant what its installer approved. Routes acting as a linked or
 * delegating person with inherited grants use that person's own permissions, not the package's.
 */
function assertRoutesWithinApprovedPermissions(
  installation: PackageInstallation,
  routes: readonly AutomationRouteCreateInput[],
) {
  const approved = new Set(
    installation.permissions.map(({ namespace, permission }) => `${namespace}.${permission}`),
  );
  for (const route of routes) {
    const grants = automationRouteActionAuthority(route.action)?.grants;
    if (grants === undefined || grants === "inherit") {
      continue;
    }
    const unapproved = grants.filter(
      ({ namespace, permission }) => !approved.has(`${namespace}.${permission}`),
    );
    if (unapproved.length > 0) {
      throw new PackageInstallationError(
        `Declared route '${route.id}' grants ${unapproved.map(({ namespace, permission }) => `${namespace}.${permission}`).join(", ")}, which the package does not declare.`,
      );
    }
  }
}

function isStewardedBy(steward: AutomationRouteSteward, listingId: string) {
  return steward.kind === "package" && steward.listingId === listingId;
}

export type PackageInstallationInput = {
  installation: PackageInstallation;
  routes: readonly AutomationRouteCreateInput[];
  actors: AutomationActors;
};

/** Refusals cross object RPC as values; anything else may succeed on a retry and is thrown. */
export type PackageInstallationOutcome = { ok: true } | { ok: false; message: string };

/**
 * Records an installation and makes its routes match the release's declarations, in one
 * transaction: declared routes are created or updated, keeping whether each is enabled, and routes
 * the package no longer declares are deleted.
 */
export async function applyPackageInstallation(
  fragment: AutomationFragment,
  input: PackageInstallationInput,
): Promise<PackageInstallationOutcome> {
  try {
    await syncPackageInstallation(fragment, input);
    return { ok: true };
  } catch (error) {
    if (error instanceof ZodError) {
      return { ok: false, message: z.prettifyError(error) };
    }
    if (
      error instanceof PackageInstallationError ||
      error instanceof AutomationRouteStewardError ||
      error instanceof AutomationRouteAuthorityError ||
      isAutomationScheduleError(error)
    ) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

async function syncPackageInstallation(
  fragment: AutomationFragment,
  { installation, routes, actors }: PackageInstallationInput,
) {
  assertRoutesWithinApprovedPermissions(installation, routes);
  const [existingRoutes, existing] = await fragment.callServices(() => [
    fragment.services.listRoutes(),
    fragment.services.getPackageInstallation({ listingId: installation.listingId }),
  ]);
  assertPackageInstallationReplaceable(existing, installation);

  const writer: AutomationRouteSteward = { kind: "package", listingId: installation.listingId };
  const existingIds = new Set(existingRoutes.map((route) => route.id));
  const declaredIds = new Set(routes.map((route) => route.id));
  const results = await fragment.callServices(() => [
    ...routes.map((route) =>
      existingIds.has(route.id)
        ? fragment.services.updateRoute(
            {
              id: route.id,
              name: route.name,
              priority: route.priority,
              trigger: route.trigger,
              action: route.action,
              description: route.description ?? null,
            },
            actors,
            // The approved permissions bound the grants, checked above.
            async () => undefined,
            writer,
          )
        : fragment.services.createRoute(route, actors, writer),
    ),
    ...existingRoutes
      .filter((route) => isStewardedBy(route.steward, installation.listingId))
      .filter((route) => !declaredIds.has(route.id))
      .map((route) => fragment.services.deleteRoute({ id: route.id }, writer)),
    fragment.services.putPackageInstallation(installation),
  ]);
  if (results.some((result) => result === null)) {
    // A route was deleted between reading and writing; the caller retries against the new state.
    throw new Error(`Routes of package '${installation.listingId}' changed during installation.`);
  }
}

/** Deletes an installation and the routes it manages, leaving its files. */
export async function uninstallPackage(
  fragment: AutomationFragment,
  { listingId }: { listingId: string },
): Promise<{ installation: PackageInstallation; removedRouteIds: string[] } | null> {
  const [routes, installation] = await fragment.callServices(() => [
    fragment.services.listRoutes(),
    fragment.services.getPackageInstallation({ listingId }),
  ]);
  if (!installation) {
    return null;
  }
  const writer: AutomationRouteSteward = { kind: "package", listingId };
  const removedRouteIds = routes
    .filter((route) => isStewardedBy(route.steward, listingId))
    .map((route) => route.id);
  await fragment.callServices(() => [
    ...removedRouteIds.map((id) => fragment.services.deleteRoute({ id }, writer)),
    fragment.services.deletePackageInstallation({ listingId }),
  ]);
  return { installation, removedRouteIds };
}
