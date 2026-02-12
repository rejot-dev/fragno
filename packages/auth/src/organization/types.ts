export type DefaultOrganizationRole = "owner" | "admin" | "member";
export type OrganizationRoleName<TRole extends string = DefaultOrganizationRole> = TRole;

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logoUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface OrganizationMember<TRole extends string = DefaultOrganizationRole> {
  id: string;
  organizationId: string;
  userId: string;
  roles: OrganizationRoleName<TRole>[];
  createdAt: Date;
  updatedAt: Date;
}

export type OrganizationInvitationStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "canceled"
  | "expired";

export interface OrganizationInvitation<TRole extends string = DefaultOrganizationRole> {
  id: string;
  organizationId: string;
  email: string;
  roles: OrganizationRoleName<TRole>[];
  status: OrganizationInvitationStatus;
  token: string;
  inviterId: string;
  expiresAt: Date;
  createdAt: Date;
  respondedAt?: Date | null;
}

export interface AutoCreateOrganizationConfig {
  name?: (ctx: { userId: string; email: string }) => string;
  slug?: (ctx: { userId: string; email: string }) => string;
  logoUrl?: (ctx: { userId: string; email: string }) => string | null | undefined;
  metadata?: (ctx: { userId: string; email: string }) => Record<string, unknown> | null | undefined;
}
