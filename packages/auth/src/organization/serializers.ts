import type { OrganizationInvitation, OrganizationMember } from "./types";

type OrganizationLike = {
  id: string;
  name: string;
  slug: string;
  logoUrl?: string | null;
  metadata?: Record<string, unknown> | null | unknown;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
};

type SerializableOrganization = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  metadata: Record<string, unknown> | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

type SerializableMember = {
  id: string;
  organizationId: string;
  userId: string;
  roles: string[];
  createdAt: string;
  updatedAt: string;
};

type SerializableInvitation = {
  id: string;
  organizationId: string;
  email: string;
  roles: string[];
  status: OrganizationInvitation<string>["status"];
  token: string;
  inviterId: string;
  expiresAt: string;
  createdAt: string;
  respondedAt: string | null;
};

type SerializableInvitationSummary = Omit<SerializableInvitation, "token">;

const normalizeMetadata = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

export function serializeOrganization(organization: OrganizationLike): SerializableOrganization {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    logoUrl: organization.logoUrl ?? null,
    metadata: normalizeMetadata(organization.metadata),
    createdBy: organization.createdBy,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
    deletedAt: organization.deletedAt ? organization.deletedAt.toISOString() : null,
  };
}

export function serializeMember<TRole extends string>(
  member: OrganizationMember<TRole>,
): SerializableMember {
  return {
    id: member.id,
    organizationId: member.organizationId,
    userId: member.userId,
    roles: member.roles as string[],
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
  };
}

export function serializeInvitation<TRole extends string>(
  invitation: OrganizationInvitation<TRole>,
): SerializableInvitation {
  return {
    id: invitation.id,
    organizationId: invitation.organizationId,
    email: invitation.email,
    roles: invitation.roles as string[],
    status: invitation.status,
    token: invitation.token,
    inviterId: invitation.inviterId,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    respondedAt: invitation.respondedAt ? invitation.respondedAt.toISOString() : null,
  };
}

export function serializeInvitationSummary<TRole extends string>(
  invitation: OrganizationInvitation<TRole>,
): SerializableInvitationSummary {
  const { token: _token, ...rest } = serializeInvitation(invitation);
  return rest;
}
