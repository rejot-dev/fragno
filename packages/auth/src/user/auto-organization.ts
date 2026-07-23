import type { TypedUnitOfWork } from "@fragno-dev/db";

import type { AuthHooksMap } from "../hooks";
import type {
  AutoCreateOrganizationConfig,
  Organization,
  OrganizationMember,
} from "../organization/types";
import {
  DEFAULT_CREATOR_ROLES,
  buildAutoOrganizationInput,
  normalizeRoleNames,
  toExternalId,
} from "../organization/utils";
import { authSchema } from "../schema";

export type AutoCreateOrganizationOptions = {
  autoCreateOrganization?: AutoCreateOrganizationConfig;
  creatorRoles?: readonly string[];
};

export type AutoCreateOrganizationResult = {
  organization: Omit<Organization, "createdAt" | "updatedAt">;
  member: Omit<OrganizationMember<string>, "createdAt" | "updatedAt">;
};

export type ResolvedAutoOrganizationInput = {
  name: string;
  slug: string;
  logoUrl: string | null | undefined;
  metadata: Record<string, unknown> | null | undefined;
};

type AuthUow = TypedUnitOfWork<typeof authSchema, unknown[], unknown, AuthHooksMap>;

const resolveAutoOrganizationSlug = (slug: string | null): string => {
  if (!slug) {
    throw new Error("Invalid auto organization slug");
  }
  return slug;
};

export const resolveAutoOrganizationInput = (input: {
  userId: string;
  email: string;
  options?: AutoCreateOrganizationOptions;
}): ResolvedAutoOrganizationInput | null => {
  if (!input.options?.autoCreateOrganization) {
    return null;
  }

  const { name, slug, logoUrl, metadata } = buildAutoOrganizationInput(
    input.options.autoCreateOrganization,
    {
      userId: input.userId,
      email: input.email,
    },
  );

  return {
    name,
    slug: resolveAutoOrganizationSlug(slug),
    logoUrl,
    metadata,
  };
};

export const createAutoOrganization = (
  uow: AuthUow,
  input: {
    userId: string;
    email: string;
    options?: AutoCreateOrganizationOptions;
    autoOrganizationInput?: ResolvedAutoOrganizationInput | null;
  },
): AutoCreateOrganizationResult | null => {
  const autoOrganizationInput =
    "autoOrganizationInput" in input
      ? input.autoOrganizationInput
      : resolveAutoOrganizationInput(input);
  if (!autoOrganizationInput) {
    return null;
  }

  const { name, slug: normalizedSlug, logoUrl, metadata } = autoOrganizationInput;
  const creatorRoles = normalizeRoleNames(input.options?.creatorRoles, DEFAULT_CREATOR_ROLES);
  const databaseNow = uow.now();

  const organizationId = uow.create("organization", {
    name,
    slug: normalizedSlug,
    logoUrl: logoUrl ?? null,
    metadata: metadata ?? null,
    createdBy: input.userId,
    createdAt: databaseNow,
    updatedAt: databaseNow,
  });

  const memberId = uow.create("organizationMember", {
    organizationId,
    userId: input.userId,
    createdAt: databaseNow,
    updatedAt: databaseNow,
  });

  for (const role of creatorRoles) {
    uow.create("organizationMemberRole", {
      memberId,
      role,
      createdAt: databaseNow,
    });
  }

  return {
    organization: {
      id: toExternalId(organizationId),
      name,
      slug: normalizedSlug,
      logoUrl: logoUrl ?? null,
      metadata: metadata ?? null,
      createdBy: input.userId,
      deletedAt: null,
    },
    member: {
      id: toExternalId(memberId),
      organizationId: toExternalId(organizationId),
      userId: input.userId,
      roles: creatorRoles,
    },
  };
};
