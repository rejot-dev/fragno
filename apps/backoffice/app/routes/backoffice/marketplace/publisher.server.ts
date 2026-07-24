import type { AuthMeData } from "@/fragno/auth/auth-client";
import type { MarketplaceOwner } from "@/fragno/marketplace/contracts";

type MarketplaceOrganizationOwner = MarketplaceOwner & {
  scope: { kind: "org"; orgId: string };
};

export const marketplaceOwnerForOrganization = (
  me: AuthMeData,
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
