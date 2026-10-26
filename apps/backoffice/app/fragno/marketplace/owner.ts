import type {
  MarketplaceOwnerScope,
  MarketplaceScope,
  MarketplaceVisibility,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  type BackofficeContextScope,
  type BackofficeOrganizationContextScope,
  backofficeScopeReferenceCodec,
  formatBackofficeScopeSegment,
  mapBackofficeScopeNames,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

/** A workspace as listings name their owner: by ID alone, not where its objects are kept. */
export function marketplaceOwnerScope(scope: BackofficeContextScope): MarketplaceOwnerScope {
  return mapBackofficeScopeNames(scope, {
    organization: ({ orgId }) => ({ orgId }),
    user: ({ userId }) => ({ userId }),
    project: ({ projectId }) => ({ projectId }),
  });
}

/**
 * Owner scopes are Backoffice scopes named by ID, so their key is their scope path segment. It
 * names no jurisdiction, so a listing keeps its ID wherever its owner's objects are kept.
 */
export const marketplaceOwnerKey = (scope: MarketplaceOwnerScope): string =>
  formatBackofficeScopeSegment(scope, backofficeScopeReferenceCodec);

export const marketplaceListingId = ({
  ownerScope,
  slug,
}: {
  ownerScope: MarketplaceOwnerScope;
  slug: string;
}): string => `${marketplaceOwnerKey(ownerScope)}#${slug}`;

export const marketplaceListingSlug = (listingId: string): string => {
  const separatorIndex = listingId.lastIndexOf("#");
  if (separatorIndex < 0 || separatorIndex === listingId.length - 1) {
    throw new Error(`Marketplace listing id ${listingId} is invalid.`);
  }
  return listingId.slice(separatorIndex + 1);
};

export const marketplaceVersionId = ({
  listingId,
  version,
}: {
  listingId: string;
  version: string;
}): string => `${listingId}@${version}`;

/** Packages are owned by an organization, so organization visibility names that organization's Marketplace. */
export function marketplaceScopeForVisibility(
  visibility: MarketplaceVisibility,
  organization: BackofficeOrganizationContextScope,
): MarketplaceScope {
  return visibility === "public" ? { kind: "system" } : organization;
}

/** An organization Marketplace holds only its own organization's listings; System accepts every owner. */
export function marketplaceAcceptsOwner(
  marketplace: MarketplaceScope,
  owner: MarketplaceOwnerScope,
): boolean {
  return (
    marketplace.kind === "system" || (owner.kind === "org" && owner.orgId === marketplace.orgId)
  );
}
