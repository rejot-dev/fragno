import type { MarketplaceOwnerScope } from "./contracts";

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

export const marketplaceListingOwnerId = (listingSlug: string, ownerKey: string): string =>
  `${listingSlug}#${ownerKey}`;
