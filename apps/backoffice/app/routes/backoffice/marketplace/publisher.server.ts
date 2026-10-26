import type {
  MarketplaceOwner,
  MarketplaceVisibility,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import type { BackofficeOrganizationContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { marketplaceScopeForVisibility } from "@/fragno/marketplace/owner";

type MarketplaceOrganizationOwner = MarketplaceOwner & {
  scope: { kind: "org"; orgId: string };
};

export const marketplaceOwnerForOrganization = (
  me: BackofficeMeData,
  organizationId: string,
): MarketplaceOrganizationOwner | null => {
  const organization = me.organizations.find(
    ({ organization: candidate }) => candidate.id === organizationId,
  )?.organization;
  if (!organization || !me.user) {
    return null;
  }

  return {
    scope: { kind: "org", orgId: organization.id },
    publisherName: organization.name,
  };
};

/** Publisher pages manage listings in the Marketplace their visibility names. */
export const marketplaceForPublisher = (
  objects: BackofficeObjectRegistry,
  organization: BackofficeOrganizationContextScope,
  visibility: MarketplaceVisibility,
) => objects.marketplace.for(marketplaceScopeForVisibility(visibility, organization)).commands;
