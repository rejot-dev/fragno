import type { HookFn } from "@fragno-dev/db";
import type {
  OrganizationHookPayload,
  OrganizationInvitationHookPayload,
  OrganizationMemberHookPayload,
} from "./organization/types";
import type { Role } from "./types";

export interface UserHookPayload {
  userId: string;
  email: string;
  role: Role;
}

export interface SessionHookPayload {
  sessionId: string;
  userId: string;
}

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
