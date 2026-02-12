import type { Role } from "../types";

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

export interface OrganizationHookPayload {
  organizationId: string;
  name: string;
  slug: string;
  createdBy: string;
}

export interface OrganizationMemberHookPayload<TRole extends string = DefaultOrganizationRole> {
  organizationId: string;
  memberId: string;
  userId: string;
  roles: OrganizationRoleName<TRole>[];
}

export interface OrganizationInvitationHookPayload<TRole extends string = DefaultOrganizationRole> {
  organizationId: string;
  invitationId: string;
  email: string;
  roles: OrganizationRoleName<TRole>[];
  inviterId: string;
}

export interface OrganizationHooks<TRole extends string = DefaultOrganizationRole> {
  onOrganizationCreated?: (payload: OrganizationHookPayload) => Promise<void> | void;
  onOrganizationUpdated?: (payload: OrganizationHookPayload) => Promise<void> | void;
  onOrganizationDeleted?: (payload: OrganizationHookPayload) => Promise<void> | void;
  onMemberAdded?: (payload: OrganizationMemberHookPayload<TRole>) => Promise<void> | void;
  onMemberRemoved?: (payload: OrganizationMemberHookPayload<TRole>) => Promise<void> | void;
  onMemberRolesUpdated?: (payload: OrganizationMemberHookPayload<TRole>) => Promise<void> | void;
  onInvitationCreated?: (payload: OrganizationInvitationHookPayload<TRole>) => Promise<void> | void;
  onInvitationAccepted?: (
    payload: OrganizationInvitationHookPayload<TRole>,
  ) => Promise<void> | void;
  onInvitationRejected?: (
    payload: OrganizationInvitationHookPayload<TRole>,
  ) => Promise<void> | void;
  onInvitationCanceled?: (
    payload: OrganizationInvitationHookPayload<TRole>,
  ) => Promise<void> | void;
}

export interface AutoCreateOrganizationConfig {
  name?: (ctx: { userId: string; email: string }) => string;
  slug?: (ctx: { userId: string; email: string }) => string;
  logoUrl?: (ctx: { userId: string; email: string }) => string | null | undefined;
  metadata?: (ctx: { userId: string; email: string }) => Record<string, unknown> | null | undefined;
}

export interface OrganizationConfig<TRole extends string = DefaultOrganizationRole> {
  roles?: readonly TRole[];
  creatorRoles?: readonly TRole[];
  defaultMemberRoles?: readonly TRole[];
  allowUserToCreateOrganization?:
    | boolean
    | ((ctx: { userId: string; userRole: Role }) => Promise<boolean>);
  invitationExpiresInDays?: number;
  autoCreateOrganization?:
    | false
    | {
        name?: (ctx: { userId: string; email: string }) => string;
        slug?: (ctx: { userId: string; email: string }) => string;
        logoUrl?: (ctx: { userId: string; email: string }) => string | null | undefined;
        metadata?: (ctx: {
          userId: string;
          email: string;
        }) => Record<string, unknown> | null | undefined;
      };
  limits?: {
    organizationsPerUser?: number;
    membersPerOrganization?: number;
    invitationsPerOrganization?: number;
  };
  hooks?: OrganizationHooks<TRole>;
}
