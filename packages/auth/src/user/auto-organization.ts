import type { TypedUnitOfWork } from "@fragno-dev/db";
import { authSchema } from "../schema";
import type { AuthHooksMap } from "../hooks";
import type {
  AutoCreateOrganizationConfig,
  Organization,
  OrganizationMember,
} from "../organization/types";
import {
  DEFAULT_CREATOR_ROLES,
  buildAutoOrganizationInput,
  normalizeOrganizationSlug,
  normalizeRoleNames,
  toExternalId,
} from "../organization/utils";

export type AutoCreateOrganizationOptions = {
  autoCreateOrganization?: AutoCreateOrganizationConfig;
  creatorRoles?: readonly string[];
};

export type AutoCreateOrganizationResult = {
  organization: Organization;
  member: OrganizationMember<string>;
};

type AuthUow = TypedUnitOfWork<typeof authSchema, unknown[], unknown, AuthHooksMap>;

const resolveAutoOrganizationSlug = (name: string, userId: string): string => {
  const normalized = normalizeOrganizationSlug(name);
  if (normalized) {
    return normalized;
  }

  const fallback = normalizeOrganizationSlug(`org-${userId.slice(0, 8)}`);
  if (!fallback) {
    throw new Error("Invalid auto organization slug");
  }
  return fallback;
};

export const createAutoOrganization = (
  uow: AuthUow,
  input: {
    userId: string;
    email: string;
    now: Date;
    options?: AutoCreateOrganizationOptions;
  },
): AutoCreateOrganizationResult | null => {
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

  const normalizedSlug = slug ?? resolveAutoOrganizationSlug(name, input.userId);
  const creatorRoles = normalizeRoleNames(input.options.creatorRoles, DEFAULT_CREATOR_ROLES);

  const organizationId = uow.create("organization", {
    name,
    slug: normalizedSlug,
    logoUrl: logoUrl ?? null,
    metadata: metadata ?? null,
    createdBy: input.userId,
    createdAt: input.now,
    updatedAt: input.now,
  });

  const memberId = uow.create("organizationMember", {
    organizationId,
    userId: input.userId,
    createdAt: input.now,
    updatedAt: input.now,
  });

  for (const role of creatorRoles) {
    uow.create("organizationMemberRole", {
      memberId,
      role,
      createdAt: input.now,
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
      createdAt: input.now,
      updatedAt: input.now,
      deletedAt: null,
    },
    member: {
      id: toExternalId(memberId),
      organizationId: toExternalId(organizationId),
      userId: input.userId,
      roles: creatorRoles,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
};
