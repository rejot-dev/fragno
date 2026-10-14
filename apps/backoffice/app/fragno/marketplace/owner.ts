import type {
  MarketplaceOwnerScope,
  MarketplaceScope,
  MarketplaceVisibility,
} from "@fragno-dev/backoffice-api/v0/marketplace";

const encodeOwnerId = (value: string) => encodeURIComponent(value.trim());

export const marketplaceOwnerKey = (scope: MarketplaceOwnerScope): string => {
  switch (scope.kind) {
    case "system":
      return "system";
    case "org":
      return `org:${encodeOwnerId(scope.orgId)}`;
    case "user":
      return `user:${encodeOwnerId(scope.userId)}`;
    case "project":
      return `project:${encodeOwnerId(scope.orgId)}:${encodeOwnerId(scope.projectId)}`;
  }

  throw new Error("Unsupported marketplace owner scope kind.");
};

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
  owner: { kind: "org"; orgId: string },
): MarketplaceScope {
  return visibility === "public" ? { kind: "system" } : { kind: "org", orgId: owner.orgId };
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
