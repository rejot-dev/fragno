import type {
  MarketplaceScope,
  MarketplaceVisibility,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  type BackofficeContextScope,
  backofficeScopeOrganization,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";

/** Catalog route segments; "marketplace" keeps the public catalog's established URL. */
export type MarketplaceCatalog = "marketplace" | "organization";

export type MarketplaceTab = MarketplaceCatalog | "my-listings";

export const marketplaceCatalogVisibility = (catalog: MarketplaceCatalog): MarketplaceVisibility =>
  catalog === "organization" ? "organization" : "public";

export const marketplaceCatalogForVisibility = (
  visibility: MarketplaceVisibility,
): MarketplaceCatalog => (visibility === "organization" ? "organization" : "marketplace");

const marketplaceScopeBasePath = (scope: BackofficeScopeSelection) =>
  `/backoffice/marketplace/${backofficeRouteScopePath(
    backofficeRouteScopeFromResolvedScope(scope),
  )}`;

export const marketplaceScopeTabPath = (
  scope: BackofficeScopeSelection,
  tab: MarketplaceTab = "marketplace",
) => `${marketplaceScopeBasePath(scope)}/${tab}`;

/** Resolves a catalog route to the Marketplace it reads from the route's scope. */
export function marketplaceForCatalog(
  scope: BackofficeContextScope,
  catalog: string | undefined,
): { catalog: MarketplaceCatalog; marketplace: MarketplaceScope } {
  if (catalog === "marketplace") {
    return { catalog, marketplace: { kind: "system" } };
  }
  // Only workspaces that belong to an organization have an organization Marketplace.
  const organization = backofficeScopeOrganization(scope);
  if (catalog === "organization" && organization) {
    return { catalog, marketplace: { kind: "org", orgId: organization.orgId } };
  }
  throw new Response("Not Found", { status: 404 });
}

/** Organization and project workspaces browse their organization's Marketplace beside the public one. */
export const marketplaceCatalogsForScope = (
  scope: BackofficeScopeSelection,
): MarketplaceCatalog[] =>
  backofficeScopeOrganization(scope) ? ["marketplace", "organization"] : ["marketplace"];
