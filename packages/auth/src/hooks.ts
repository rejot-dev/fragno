import type { HookFn } from "@fragno-dev/db";
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

export interface SessionSummary {
  id: string;
  user: UserSummary;
  expiresAt: Date;
  activeOrganizationId: string | null;
}

export interface SessionHookPayload {
  session: SessionSummary;
  actor: UserSummary | null;
}

export interface BeforeCreateUserPayload {
  email: string;
  role: UserSummary["role"];
}

// Synchronous to ensure checks run before mutations are committed.
export type BeforeCreateUserHook = (payload: BeforeCreateUserPayload) => void;

export interface AuthHooks {
  onUserCreated?: (payload: UserHookPayload) => Promise<void> | void;
  onUserRoleUpdated?: (payload: UserHookPayload) => Promise<void> | void;
  onUserPasswordChanged?: (payload: UserHookPayload) => Promise<void> | void;
  onSessionCreated?: (payload: SessionHookPayload) => Promise<void> | void;
  onSessionInvalidated?: (payload: SessionHookPayload) => Promise<void> | void;
}

export type AuthHooksMap = {
  onUserCreated: HookFn<UserHookPayload>;
  onUserRoleUpdated: HookFn<UserHookPayload>;
  onUserPasswordChanged: HookFn<UserHookPayload>;
  onSessionCreated: HookFn<SessionHookPayload>;
  onSessionInvalidated: HookFn<SessionHookPayload>;
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
};
