import type { DbNow, HookFn } from "@fragno-dev/db";

import type {
  OrganizationHookPayload,
  OrganizationInvitationHookPayload,
  OrganizationMemberHookPayload,
} from "./organization/types";
import type { UserSummary } from "./types";

export interface UserHookPayload {
  user: UserSummary;
  actor: UserSummary | null;
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

// Synchronous to ensure checks run before mutations are committed.
export type BeforeCreateUserHook = (payload: BeforeCreateUserPayload) => BeforeCreateUserResult;

export interface AuthHookContext {
  idempotencyKey: string;
  hookId: string;
}

export interface AuthHooks {
  onUserCreated?: (payload: UserHookPayload, context: AuthHookContext) => Promise<void> | void;
  onUserRoleUpdated?: (payload: UserHookPayload, context: AuthHookContext) => Promise<void> | void;
  onUserPasswordChanged?: (
    payload: UserHookPayload,
    context: AuthHookContext,
  ) => Promise<void> | void;
  onCredentialIssued?: (
    payload: CredentialHookPayload,
    context: AuthHookContext,
  ) => Promise<void> | void;
  onCredentialInvalidated?: (
    payload: CredentialHookPayload,
    context: AuthHookContext,
  ) => Promise<void> | void;
}

export type AuthHooksMap = {
  onUserCreated: HookFn<UserHookPayload>;
  onUserRoleUpdated: HookFn<UserHookPayload>;
  onUserPasswordChanged: HookFn<UserHookPayload>;
  onCredentialIssued: HookFn<CredentialHookPayload>;
  onCredentialInvalidated: HookFn<CredentialHookPayload>;
  onOrganizationCreated: HookFn<OrganizationHookPayload>;
  onOrganizationUpdated: HookFn<OrganizationHookPayload>;
  onOrganizationDeleted: HookFn<OrganizationHookPayload>;
  onMemberAdded: HookFn<OrganizationMemberHookPayload<string>>;
  onMemberRemoved: HookFn<OrganizationMemberHookPayload<string>>;
  onMemberRolesUpdated: HookFn<OrganizationMemberHookPayload<string>>;
  onInvitationCreated: HookFn<OrganizationInvitationHookPayload<string>>;
  onInvitationAccepted: HookFn<OrganizationInvitationHookPayload<string>>;
  onInvitationRejected: HookFn<OrganizationInvitationHookPayload<string>>;
  onInvitationCanceled: HookFn<OrganizationInvitationHookPayload<string>>;
  onInvitationExpired: HookFn<InvitationExpiredHookPayload>;
};
