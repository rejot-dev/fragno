import type { AutomationRouteCreateInput } from "@fragno-dev/backoffice-api/v0/automation";
import {
  marketplacePackageDeclarationSchema,
  type MarketplacePackageDeclaration,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { z } from "zod";

import { normalizeMarketplacePackagePath } from "./package-files";

/** What installing a release sets up in a workspace, beyond copying its files. */
export const MARKETPLACE_DECLARATION_PATH = ".marketplace/installation.json";

export const EMPTY_MARKETPLACE_PACKAGE_DECLARATION: MarketplacePackageDeclaration = {
  permissions: [],
  routes: [],
  eventDefinitions: [],
  agents: [],
};

export class MarketplacePackageDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplacePackageDeclarationError";
  }
}

export function parseMarketplacePackageDeclaration(source: string): MarketplacePackageDeclaration {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw new MarketplacePackageDeclarationError(
      `Marketplace package ${MARKETPLACE_DECLARATION_PATH} is not valid JSON.`,
    );
  }
  const declaration = marketplacePackageDeclarationSchema.safeParse(json);
  if (!declaration.success) {
    throw new MarketplacePackageDeclarationError(
      `Marketplace package ${MARKETPLACE_DECLARATION_PATH} is invalid: ${z.prettifyError(declaration.error)}`,
    );
  }
  return declaration.data;
}

function permissionKey({ namespace, permission }: BackofficePermissionRequirement) {
  return `${namespace}.${permission}`;
}

export function formatPackagePermissions(permissions: readonly BackofficePermissionRequirement[]) {
  return permissions.length ? permissions.map(permissionKey).join(", ") : "none";
}

/** An installer approves exactly what a release declares, so a release can't gain more unnoticed. */
export function assertPackagePermissionsApproved({
  declared,
  approved,
}: {
  declared: readonly BackofficePermissionRequirement[];
  approved: readonly BackofficePermissionRequirement[];
}) {
  const approvedKeys = new Set(approved.map(permissionKey));
  if (
    declared.length !== approved.length ||
    !declared.every((permission) => approvedKeys.has(permissionKey(permission)))
  ) {
    throw new MarketplacePackageDeclarationError(
      `This release declares the permissions ${formatPackagePermissions(declared)}, but the installation approved ${formatPackagePermissions(approved)}. Approve exactly the declared permissions to install it.`,
    );
  }
}

/** Points declared workflow routes at the installed copies of the package's files. */
export function resolveDeclaredPackageRoutes({
  declaration,
  installationRoot,
  installedPaths,
}: {
  declaration: MarketplacePackageDeclaration;
  installationRoot: string;
  installedPaths: ReadonlySet<string>;
}): AutomationRouteCreateInput[] {
  return declaration.routes.map((route) => {
    if (route.action.kind !== "start_workflow") {
      return route;
    }
    const relativePath = route.action.workflowScriptPath;
    if (relativePath.startsWith("/") || !installedPaths.has(relativePath)) {
      throw new MarketplacePackageDeclarationError(
        `Declared route '${route.id}' starts '${relativePath}', which is not a file this package installs.`,
      );
    }
    return {
      ...route,
      action: {
        ...route.action,
        workflowScriptPath: `${installationRoot}/${normalizeMarketplacePackagePath(relativePath)}`,
      },
    };
  });
}

/** Reads a published release's declaration; a release without one declares nothing. */
export async function readMarketplacePackageDeclaration({
  http,
  version,
}: {
  http: { fetch(request: Request): Promise<Response> };
  version: string;
}): Promise<MarketplacePackageDeclaration> {
  const url = new URL("https://upload.internal/api/upload/files/by-key/content");
  url.searchParams.set("key", `${version}/${MARKETPLACE_DECLARATION_PATH}`);
  const response = await http.fetch(new Request(url));
  if (response.status === 404 || response.status === 410) {
    return EMPTY_MARKETPLACE_PACKAGE_DECLARATION;
  }
  if (!response.ok) {
    throw new Error(`Marketplace package declaration could not be read (${response.status}).`);
  }
  return parseMarketplacePackageDeclaration(await response.text());
}
