import {
  marketplaceSlugSchema,
  type MarketplaceVisibility,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { z } from "zod";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import { marketplaceListingSlug } from "@/fragno/marketplace/owner";

import { marketplaceScopeTabPath, type MarketplaceCatalog } from "./scope";

export const marketplaceListingRouteSchema = z.object({
  publisher: z
    .string()
    .regex(/^(?:@[a-z0-9]+(?:-[a-z0-9]+)*|system|user:[^/#]+|project:[^/#:]+:[^/#]+)$/u),
  packageSlug: marketplaceSlugSchema,
});

/** Public listing pages hand installation to the signed-in user's active workspace. */
export function marketplaceInstallEntryPath(listingRef: string): string {
  return `/backoffice/marketplace?${new URLSearchParams({ listing: listingRef })}`;
}

/** Catalogs open on their featured listings; this view lists every published listing. */
export function marketplaceCatalogAllPath(
  scope: BackofficeScopeSelection,
  catalog: MarketplaceCatalog,
): string {
  return `${marketplaceScopeTabPath(scope, catalog)}/all`;
}

export function marketplaceListingPath(
  listingRef: string,
  scope: BackofficeScopeSelection,
  catalog: MarketplaceCatalog,
): string {
  return `${marketplaceScopeTabPath(scope, catalog)}/${listingRef}`;
}

export function buildArtifactVersionPath(
  pathname: string,
  currentSearch: string,
  currentVersion: string,
  nextVersion: string,
): string {
  const search = new URLSearchParams(currentSearch);
  search.set("artifactVersion", nextVersion);

  const selectedPath = search.get("artifactPath")?.trim();
  const currentVersionRoot = `/artifact/${currentVersion}`;
  if (selectedPath === currentVersionRoot || selectedPath?.startsWith(`${currentVersionRoot}/`)) {
    search.set(
      "artifactPath",
      `/artifact/${nextVersion}${selectedPath.slice(currentVersionRoot.length)}`,
    );
  }

  return `${pathname}?${search}`;
}

export function marketplaceListingManagePath({
  listingId,
  organizationSlug,
  visibility,
  result,
}: {
  listingId: string;
  organizationSlug: string;
  visibility: MarketplaceVisibility;
  result?: Readonly<Record<string, string>>;
}): string {
  const search = new URLSearchParams({ visibility });
  for (const [name, value] of Object.entries(result ?? {})) {
    search.set(name, value);
  }
  return `/backoffice/marketplace/@${organizationSlug}/${marketplaceListingSlug(listingId)}/manage?${search.toString()}`;
}
