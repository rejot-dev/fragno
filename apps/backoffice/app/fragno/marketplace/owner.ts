import type { AutomationActors } from "@fragno-dev/backoffice-api/v0/automation";
import {
  marketplaceScopeSchema,
  type MarketplaceOwnerScope,
  type MarketplaceScope,
  type MarketplaceSourceVisibility,
  type MarketplaceVisibility,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import {
  type BackofficeContextScope,
  type BackofficeOrganizationContextScope,
  backofficeScopePathSegment,
  backofficeScopeReferenceCodec,
  formatBackofficeScopeSegment,
  mapBackofficeScopeNames,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type {
  BackofficeObjectHandle,
  BackofficeObjectRegistry,
  BackofficeObjectScope,
  MarketplaceCommands,
} from "@/backoffice-runtime/object-registry";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import { installedAppIdOfActors } from "@/fragno/app-installations/authority";

/** A workspace as listings name their owner: by ID alone, not where its objects are kept. */
export function marketplaceOwnerScope(scope: BackofficeContextScope): MarketplaceOwnerScope {
  return mapBackofficeScopeNames(scope, {
    organization: ({ orgId }) => ({ orgId }),
    user: ({ userId }) => ({ userId }),
    project: ({ projectId }) => ({ projectId }),
  });
}

/**
 * Other owner scopes are Backoffice scopes named by ID, so their key is their scope path segment.
 * It names no jurisdiction, so a listing keeps its ID wherever its owner's objects are kept. A
 * registered app has no scope; its key is its slug, which never changes.
 */
export const marketplaceOwnerKey = (scope: MarketplaceOwnerScope): string =>
  scope.kind === "registered-app"
    ? `app:${scope.slug}`
    : formatBackofficeScopeSegment(scope, backofficeScopeReferenceCodec);

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

/** An installed app's own Marketplace has no Backoffice scope, so its object is named by the app. */
const APP_MARKETPLACE_OBJECT_PREFIX = "app:";

/** The object that keeps a Marketplace. */
export function marketplaceObject(
  objects: Pick<BackofficeObjectRegistry, "marketplace">,
  marketplace: MarketplaceScope,
): BackofficeObjectHandle<MarketplaceCommands> {
  return marketplace.kind === "app"
    ? objects.marketplace.forName(`${APP_MARKETPLACE_OBJECT_PREFIX}${marketplace.appId}`)
    : objects.marketplace.for(marketplace);
}

/** The Marketplace a Marketplace object keeps, from the address `marketplaceObject` gave it. */
export function marketplaceOfObject(scope: BackofficeObjectScope): MarketplaceScope {
  if (scope.kind === "named") {
    if (!scope.name.startsWith(APP_MARKETPLACE_OBJECT_PREFIX)) {
      throw new Error(`Marketplace object '${scope.name}' names no app.`);
    }
    return { kind: "app", appId: scope.name.slice(APP_MARKETPLACE_OBJECT_PREFIX.length) };
  }
  return marketplaceScopeSchema.parse(scope.kind === "singleton" ? { kind: "system" } : scope);
}

/**
 * Names a Marketplace exactly. System and organization Marketplaces keep their scope's path
 * segment, which identities recorded before app Marketplaces existed were built from.
 */
export function marketplaceScopeKey(marketplace: MarketplaceScope): string {
  return marketplace.kind === "app"
    ? `marketplace-app:${marketplace.appId}`
    : backofficeScopePathSegment(marketplace);
}

export function marketplaceScopesEqual(left: MarketplaceScope, right: MarketplaceScope): boolean {
  return marketplaceScopeKey(left) === marketplaceScopeKey(right);
}

/** The Marketplaces people browse and publish to; an app's Marketplace is only installed from. */
export type BrowsableMarketplaceScope = Exclude<MarketplaceScope, { kind: "app" }>;

/**
 * The Marketplace reads and installs address: the public one, the execution's organization's, or
 * the app's own for an installed app. Both come from the execution, so callers cannot name
 * another organization's or app's Marketplace.
 */
export function marketplaceScopeForSource(
  visibility: MarketplaceSourceVisibility,
  execution: { organization: BackofficeOrganizationContextScope | null; actors: AutomationActors },
): MarketplaceScope {
  if (visibility === "public") {
    return { kind: "system" };
  }
  if (visibility === "organization") {
    if (!execution.organization) {
      throw new BackofficeOperationError(
        "forbidden",
        "Organization Marketplace reads require an organization or project workspace.",
      );
    }
    return execution.organization;
  }
  const appId = installedAppIdOfActors(execution.actors);
  if (!appId) {
    throw new BackofficeOperationError(
      "forbidden",
      "Only an installed app reads and installs from its app's Marketplace.",
    );
  }
  return { kind: "app", appId };
}

/** Packages are owned by an organization, so organization visibility names that organization's Marketplace. */
export function marketplaceScopeForVisibility(
  visibility: MarketplaceVisibility,
  organization: BackofficeOrganizationContextScope,
): BrowsableMarketplaceScope {
  return visibility === "public" ? { kind: "system" } : organization;
}

/**
 * An organization Marketplace holds only its own organization's listings, and an app's only its
 * app's; System accepts every owner.
 */
export function marketplaceAcceptsOwner(
  marketplace: MarketplaceScope,
  owner: MarketplaceOwnerScope,
): boolean {
  if (marketplace.kind === "org") {
    return owner.kind === "org" && owner.orgId === marketplace.orgId;
  }
  if (marketplace.kind === "app") {
    return owner.kind === "registered-app" && owner.appId === marketplace.appId;
  }
  return true;
}
