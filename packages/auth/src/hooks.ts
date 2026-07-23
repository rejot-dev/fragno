import type { DbNow, HookContext, HookFn } from "@fragno-dev/db";

import type {
  Organization,
  OrganizationHookPayload,
  OrganizationInvitationHookPayload,
  OrganizationMember,
  OrganizationMemberHookPayload,
} from "./organization/types";
import type { UserSummary } from "./types";

export interface UserHookPayload {
  user: UserSummary;
  actor: UserSummary | null;
}

export interface UserCreatedHookPayload extends UserHookPayload {
  emailVerifiedAt: Date | null;
}

export interface UserEmailVerifiedHookPayload extends UserHookPayload {
  emailVerifiedAt: Date;
}

export interface DurableUserCreatedHookPayload extends UserHookPayload {
  emailVerifiedAt: string | null;
}

export interface DurableUserEmailVerifiedHookPayload extends UserHookPayload {
  emailVerifiedAt: string;
}

export type UserEmailVerificationRequestReason = "sign_up" | "sign_in" | "oauth" | "resend";

export interface UserEmailVerificationRequestedHookPayload {
  user: UserSummary;
  reason: UserEmailVerificationRequestReason;
}

export interface CredentialSummary {
  id: string;
  user: UserSummary;
  expiresAt: Date | DbNow;
  activeOrganizationId: string | null;
}

export interface CredentialHookPayload {
  credential: CredentialSummary;
  actor: UserSummary | null;
}

export interface BeforeCreateUserPayload {
  email: string;
  role: UserSummary["role"];
}

export interface InvitationExpiredHookPayload {
  invitationId: string;
}

export type BeforeCreateUserResult = void | { role?: UserSummary["role"] };

export interface DurableOrganizationCreatedHookPayload extends Omit<
  OrganizationHookPayload,
  "organization"
> {
  organization: Omit<Organization, "createdAt" | "updatedAt">;
}

export interface DurableOrganizationMemberAddedHookPayload<
  TRole extends string = string,
> extends Omit<OrganizationMemberHookPayload<TRole>, "organization" | "member"> {
  organization: Omit<Organization, "createdAt" | "updatedAt">;
  member: Omit<OrganizationMember<TRole>, "createdAt" | "updatedAt">;
}

// Synchronous to ensure checks run before mutations are committed.
export type BeforeCreateUserHook = (payload: BeforeCreateUserPayload) => BeforeCreateUserResult;

export interface AuthHooks {
  onUserCreated?: (payload: UserCreatedHookPayload, context: HookContext) => Promise<void> | void;
  onUserEmailVerified?: (
    payload: UserEmailVerifiedHookPayload,
    context: HookContext,
  ) => Promise<void> | void;
  onUserEmailVerificationRequested?: (
    payload: UserEmailVerificationRequestedHookPayload,
    context: HookContext,
  ) => Promise<void> | void;
  onUserRoleUpdated?: (payload: UserHookPayload, context: HookContext) => Promise<void> | void;
  onUserPasswordChanged?: (payload: UserHookPayload, context: HookContext) => Promise<void> | void;
  onCredentialIssued?: (
    payload: CredentialHookPayload,
    context: HookContext,
  ) => Promise<void> | void;
  onCredentialInvalidated?: (
    payload: CredentialHookPayload,
    context: HookContext,
  ) => Promise<void> | void;
}

export type AuthHooksMap = {
  onUserCreated: HookFn<DurableUserCreatedHookPayload>;
  onUserEmailVerified: HookFn<DurableUserEmailVerifiedHookPayload>;
  onUserEmailVerificationRequested: HookFn<UserEmailVerificationRequestedHookPayload>;
  onUserRoleUpdated: HookFn<UserHookPayload>;
  onUserPasswordChanged: HookFn<UserHookPayload>;
  onCredentialIssued: HookFn<CredentialHookPayload>;
  onCredentialInvalidated: HookFn<CredentialHookPayload>;
  onOrganizationCreated: HookFn<DurableOrganizationCreatedHookPayload>;
  onOrganizationUpdated: HookFn<OrganizationHookPayload>;
  onOrganizationDeleted: HookFn<OrganizationHookPayload>;
  onMemberAdded: HookFn<DurableOrganizationMemberAddedHookPayload>;
  onMemberRemoved: HookFn<OrganizationMemberHookPayload<string>>;
  onMemberRolesUpdated: HookFn<OrganizationMemberHookPayload<string>>;
  onInvitationCreated: HookFn<OrganizationInvitationHookPayload<string>>;
  onInvitationAccepted: HookFn<OrganizationInvitationHookPayload<string>>;
  onInvitationRejected: HookFn<OrganizationInvitationHookPayload<string>>;
  onInvitationCanceled: HookFn<OrganizationInvitationHookPayload<string>>;
  onInvitationExpired: HookFn<InvitationExpiredHookPayload>;
};
