# Auth Organizations and Roles - Spec

## 0. Open Questions

None.

## 1. Overview

This document specifies first-class organization support inside `@fragno-dev/auth`. The goal is to
add a minimal but complete organization layer (organizations, members, multi-role assignments,
invitations, active organization selection) while keeping the HTTP surface conservative and aligned
with existing auth routes and Fragno patterns.

The design is informed by the Better Auth organization plugin (schema, active organization stored on
session, hooks for lifecycle events) but adapted to Fragno's fragment model, durable hooks, and
service/route conventions. Roles are defined in code (config) only; no permissions are stored or
managed by the fragment.

## 2. References

- Auth fragment entry: `packages/auth/src/index.ts`
- Auth schema: `packages/auth/src/schema.ts`
- Auth routes/services: `packages/auth/src/user/user-actions.ts`,
  `packages/auth/src/session/session.ts`, `packages/auth/src/user/user-overview.ts`
- Durable hook pattern: `packages/fragment-mailing-list/src/definition.ts`
- Better Auth organization plugin: `specs/references/better-auth-organization.md`

## 3. Terminology

- Organization: A tenant/workspace that groups members and resources.
- Member: A user who belongs to an organization with one or more roles.
- Role: A named access level within an organization (ex: owner, admin, member).
- Role assignment: A specific role granted to a member.
- Invitation: A pending request to join an organization, addressed to an email.
- Active organization: The organization currently selected for a session.
- Slug: A unique, human-friendly identifier for an organization.

## 4. Goals / Non-goals

### 4.1 Goals

1. Add organization, member, role assignment, and invitation persistence to `@fragno-dev/auth`.
2. Provide service methods for creating and managing every new object type.
3. Offer a conservative set of HTTP endpoints for common organization flows.
4. Add durable hooks for user, membership, and invitation lifecycle events.
5. Store an active organization on the session for quick context switching.
6. Support multiple roles per member.
7. Allow optional automatic organization creation on user creation (same transaction).
8. Preserve existing auth behavior for users and sessions.

### 4.2 Non-goals

- Teams/sub-teams within organizations (explicitly out of scope for now).
- SCIM/SSO provisioning or external directory sync.
- A full permission evaluation engine across fragments (leave to host apps).
- Organization billing, subscriptions, or usage metering.

## 5. Packages / Components

All changes live in `packages/auth`:

- `src/schema.ts`: add new organization tables and session columns.
- `src/organization/*`: new services and routes for organization flows.
- `src/index.ts`: extend config, hooks, services, and clients.
- Tests colocated with new modules (ex: `organization-actions.test.ts`).

### 5.1 Code organization (recommended)

- `src/organization/organization-services.ts`: create/update orgs, list orgs, soft delete.
- `src/organization/member-services.ts`: add/remove members, update roles, list members.
- `src/organization/invitation-services.ts`: invite, list, accept/reject/cancel.
- `src/organization/active-organization.ts`: set/get active org for sessions.
- `src/organization/routes.ts`: route definitions wiring to services.
- `src/organization/types.ts`: shared types and helpers (slug validation, role validation).

This mirrors the existing `user` and `session` modules and keeps routes thin.

## 6. User-facing API

### 6.1 Config (generic over roles)

Roles are configured in code only. The fragment does not store permissions or expose role management
endpoints.

```ts
export type DefaultOrganizationRole = "owner" | "admin" | "member";
export type OrganizationRoleName<TRole extends string = DefaultOrganizationRole> = TRole;

export interface OrganizationConfig<TRole extends string = DefaultOrganizationRole> {
  roles?: readonly TRole[]; // default: ["owner", "admin", "member"]
  creatorRoles?: readonly TRole[]; // default: ["owner"]
  defaultMemberRoles?: readonly TRole[]; // default: ["member"]

  allowUserToCreateOrganization?:
    | boolean
    | ((ctx: { userId: string; userRole: Role }) => Promise<boolean>);

  invitationExpiresInDays?: number; // default 3

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

export interface AuthHooks {
  onUserCreated?: (payload: UserHookPayload) => Promise<void> | void;
  onUserRoleUpdated?: (payload: UserHookPayload) => Promise<void> | void;
  onUserPasswordChanged?: (payload: UserHookPayload) => Promise<void> | void;
  onSessionCreated?: (payload: SessionHookPayload) => Promise<void> | void;
  onSessionInvalidated?: (payload: SessionHookPayload) => Promise<void> | void;
}

export interface AuthConfig<TRole extends string = DefaultOrganizationRole> {
  cookieOptions?: CookieOptions;
  hooks?: AuthHooks;
  organizations?: OrganizationConfig<TRole> | false; // false disables orgs entirely
}
```

Notes:

- If `organizations` is `false`, organization services/routes/hooks are not registered.
- If `organizations` is `undefined`, the default organization config is used.
- `roles` are validated at runtime; only configured role names are accepted.
- `autoCreateOrganization` only applies when organizations are enabled.
- `sendEmail` is removed from `AuthConfig`; use hooks to send mail.

### 6.2 Types

```ts
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

export interface UserHookPayload {
  userId: string;
  email: string;
  role: Role;
}

export interface SessionHookPayload {
  sessionId: string;
  userId: string;
}
```

### 6.3 Services

Add service methods that create and manage each new object type. Example list:

- `createOrganization({ name, slug, creatorUserId, metadata })`
- `createOrganizationMember({ organizationId, userId, roles })`
- `createOrganizationMemberRole({ organizationId, memberId, role, actor })`
- `removeOrganizationMemberRole({ organizationId, memberId, role, actor })`
- `createOrganizationInvitation({ organizationId, email, roles, inviterId })`
- `getOrganizationsForUser({ userId, cursor, pageSize })`
- `getOrganizationById({ organizationId })`
- `getOrganizationBySlug({ slug })`
- `listOrganizationMembers({ organizationId, cursor, pageSize })`
- `updateOrganization({ organizationId, ...patch })`
- `updateOrganizationMemberRoles({ memberId, roles })`
- `removeOrganizationMember({ memberId })`
- `listOrganizationInvitations({ organizationId, status })`
- `listOrganizationInvitationsForUser({ email, status })`
- `respondToOrganizationInvitation({ invitationId, token, action })`
- `setActiveOrganization({ sessionId, organizationId })`
- `getActiveOrganization({ sessionId })`

All mutation services must use `serviceTx(authSchema)` and enforce the authorization rules defined
in section 10. `createOrganization` must validate and normalize slugs and seed the creator's roles.

### 6.4 Hooks

Define durable hooks via `provideHooks`, triggered with `uow.triggerHook` inside mutations:

```ts
export interface OrganizationHookPayload {
  organization: Organization;
  actor: UserSummary | null;
}

export interface OrganizationMemberHookPayload<TRole extends string = DefaultOrganizationRole> {
  organization: Organization;
  member: OrganizationMember<TRole>;
  actor: UserSummary | null;
}

export interface OrganizationInvitationHookPayload<TRole extends string = DefaultOrganizationRole> {
  organization: Organization;
  invitation: OrganizationInvitation<TRole>;
  actor: UserSummary | null;
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
```

Trigger points:

- `onUserCreated`: after user row is created.
- `onUserRoleUpdated`: after global user role change.
- `onUserPasswordChanged`: after password update.
- `onSessionCreated`: after session is created.
- `onSessionInvalidated`: after session is removed.
- `onOrganizationCreated`: after org + creator membership are created.
- `onOrganizationUpdated`: after org fields are updated.
- `onOrganizationDeleted`: after org is soft-deleted.
- `onMemberAdded`: after membership row is created.
- `onMemberRemoved`: after membership row is deleted.
- `onMemberRolesUpdated`: after member role set changes.
- `onInvitationCreated`: after invitation row is created.
- `onInvitationAccepted`/`Rejected`/`Canceled`: after status change.

Hooks are durable and run after commit, so they must not assume in-transaction state.

### 6.5 Client API

Extend `createAuthFragmentClients` with organization hooks/mutators:

```ts
const useMe = b.createHook("/me");
const useOrganizations = b.createHook("/organizations");
const useOrganization = b.createHook("/organizations/:organizationId");
const useCreateOrganization = b.createMutator("POST", "/organizations");
const useUpdateOrganization = b.createMutator("PATCH", "/organizations/:organizationId");
const useDeleteOrganization = b.createMutator("DELETE", "/organizations/:organizationId");
const useActiveOrganization = b.createHook("/organizations/active");
const useSetActiveOrganization = b.createMutator("POST", "/organizations/active");
const useOrganizationMembers = b.createHook("/organizations/:organizationId/members");
const useAddOrganizationMember = b.createMutator("POST", "/organizations/:organizationId/members");
const useUpdateOrganizationMemberRoles = b.createMutator(
  "PATCH",
  "/organizations/:organizationId/members/:memberId",
);
const useRemoveOrganizationMember = b.createMutator(
  "DELETE",
  "/organizations/:organizationId/members/:memberId",
);
const useOrganizationInvitations = b.createHook("/organizations/:organizationId/invitations");
const useInviteOrganizationMember = b.createMutator(
  "POST",
  "/organizations/:organizationId/invitations",
);
const useRespondOrganizationInvitation = b.createMutator(
  "PATCH",
  "/organizations/invitations/:invitationId",
);
const useUserInvitations = b.createHook("/organizations/invitations");
```

## 7. Data Model

Extend `authSchema` with the following tables.

### 7.1 organization

- `id` (idColumn)
- `name` (string, required)
- `slug` (string, required, unique)
- `logoUrl` (string, nullable)
- `metadata` (json, nullable)
- `createdBy` (reference to `user.id`)
- `createdAt` (timestamp, default now)
- `updatedAt` (timestamp, default now)
- `deletedAt` (timestamp, nullable)

Indexes:

- `idx_organization_slug` unique on `slug`
- `idx_organization_createdBy` on `createdBy`

### 7.2 organizationMember

- `id` (idColumn)
- `organizationId` (reference to `organization.id`)
- `userId` (reference to `user.id`)
- `createdAt` (timestamp, default now)
- `updatedAt` (timestamp, default now)

Indexes:

- `idx_org_member_org_user` unique on (`organizationId`, `userId`)
- `idx_org_member_user` on `userId`
- `idx_org_member_org` on `organizationId`

### 7.3 organizationMemberRole

- `id` (idColumn)
- `memberId` (reference to `organizationMember.id`)
- `role` (string)
- `createdAt` (timestamp, default now)

Indexes:

- `idx_org_member_role_member_role` unique on (`memberId`, `role`)
- `idx_org_member_role_member` on `memberId`

### 7.4 organizationInvitation

- `id` (idColumn)
- `organizationId` (reference to `organization.id`)
- `email` (string)
- `roles` (json array of strings)
- `status` (string)
- `token` (string, unique)
- `inviterId` (reference to `user.id`)
- `expiresAt` (timestamp)
- `createdAt` (timestamp, default now)
- `respondedAt` (timestamp, nullable)

Indexes:

- `idx_org_invitation_token` unique on `token`
- `idx_org_invitation_org_status` on (`organizationId`, `status`)
- `idx_org_invitation_email` on `email`

### 7.5 session changes

Add `activeOrganizationId` (reference to `organization.id`, nullable) to the `session` table.

## 8. Execution Model / Lifecycle

### 8.1 Create organization

1. Validate slug uniqueness and `allowUserToCreateOrganization`.
2. Create `organization` row.
3. Create member row for the creator.
4. Create role assignments for `creatorRoles` (default `["owner"]`).
5. If the session has no active organization, set `activeOrganizationId` to the new org.
6. Trigger `onOrganizationCreated` and `onMemberAdded` hooks.

### 8.2 Auto-create organization on user creation

When `organizations.autoCreateOrganization` is configured, user creation must:

1. Create the user row.
2. Create an organization for the user in the **same transaction**.
3. Create the membership and role assignments for `creatorRoles`.
4. Set `activeOrganizationId` on the newly created session if present.
5. Trigger `onUserCreated`, `onOrganizationCreated`, and `onMemberAdded` hooks.

Default naming:

- If `autoCreateOrganization` does not specify a `name`/`slug` function, use
  `"<email local-part>'s Organization"` and slugify it.

### 8.3 Invite member

1. Validate inviter permissions.
2. Create invitation with `status = "pending"` and `expiresAt`.
3. Trigger `onInvitationCreated` hook (host app may send email).

### 8.4 Accept/Reject/Cancel invitation

- Accept: validate token, pending status, and expiry, create member + roles, set status to
  `accepted`, set `respondedAt`, trigger `onInvitationAccepted`.
- Reject: validate token, set status to `rejected`, set `respondedAt`, trigger
  `onInvitationRejected`.
- Cancel: only inviter or org admin; set status to `canceled`, set `respondedAt`, trigger
  `onInvitationCanceled`.

### 8.5 Update membership

- Role updates only by owners/admins.
- Removing members requires owner/admin; cannot remove the last owner.
- Updating roles replaces the full role set for the member.

### 8.6 Active organization

- `setActiveOrganization` validates membership and updates the session.
- `getActiveOrganization` returns org + member roles for the session.

## 9. HTTP API

All endpoints require a valid session and use the existing cookie/sessionId extraction logic.

### 9.1 /me

`GET /me` MUST include all data needed to bootstrap a SPA.

Output:

```ts
{
  user: { id: string; email: string; role: Role };
  organizations: Array<{
    organization: Organization;
    member: OrganizationMember;
  }>;
  activeOrganization: {
    organization: Organization;
    member: OrganizationMember;
  } | null;
  invitations: Array<{
    invitation: OrganizationInvitation;
    organization: Organization;
  }>;
}
```

If organizations are disabled, `organizations` is `[]`, `activeOrganization` is `null`, and
`invitations` is `[]`.

### 9.2 Organizations

- `POST /organizations`
  - Input: `{ name, slug, logoUrl?, metadata? }`
  - Output: `{ organization, member }`
  - Errors: `organization_slug_taken`, `permission_denied`, `limit_reached`

- `GET /organizations`
  - Query: `cursor`, `pageSize`
  - Output: `{ organizations, cursor, hasNextPage }`

- `GET /organizations/:organizationId`
  - Output: `{ organization, member }`
  - Errors: `organization_not_found`, `permission_denied`

- `PATCH /organizations/:organizationId`
  - Input: `{ name?, slug?, logoUrl?, metadata? }`
  - Output: `{ organization }`
  - Errors: `organization_not_found`, `organization_slug_taken`, `permission_denied`

- `DELETE /organizations/:organizationId`
  - Output: `{ success: true }`
  - Errors: `organization_not_found`, `permission_denied`

### 9.3 Active organization

- `GET /organizations/active`
  - Output: `{ organization, member } | null`

- `POST /organizations/active`
  - Input: `{ organizationId }`
  - Output: `{ organization, member }`
  - Errors: `organization_not_found`, `membership_not_found`

### 9.4 Members

- `GET /organizations/:organizationId/members`
  - Query: `cursor`, `pageSize`
  - Output: `{ members, cursor, hasNextPage }`
  - Errors: `organization_not_found`, `permission_denied`

- `POST /organizations/:organizationId/members`
  - Input: `{ userId, roles? }`
  - Output: `{ member }`
  - Errors: `organization_not_found`, `permission_denied`, `member_already_exists`, `limit_reached`

- `PATCH /organizations/:organizationId/members/:memberId`
  - Input: `{ roles }`
  - Output: `{ member }`
  - Errors: `member_not_found`, `permission_denied`, `last_owner`

- `DELETE /organizations/:organizationId/members/:memberId`
  - Output: `{ success: true }`
  - Errors: `member_not_found`, `permission_denied`, `last_owner`

### 9.5 Invitations

- `GET /organizations/invitations`
  - Output: `{ invitations }` (pending invitations for the current user email)

- `GET /organizations/:organizationId/invitations`
  - Output: `{ invitations }` (tokens omitted)
  - Errors: `organization_not_found`, `permission_denied`

- `POST /organizations/:organizationId/invitations`
  - Input: `{ email, roles? }`
  - Output: `{ invitation }` (includes `token`)
  - Errors: `organization_not_found`, `permission_denied`, `limit_reached`

- `PATCH /organizations/invitations/:invitationId`
  - Input: `{ action: "accept" | "reject" | "cancel", token? }`
  - Output: `{ invitation }`
  - Errors: `invitation_not_found`, `invitation_expired`, `permission_denied`, `invalid_token`

`accept` and `reject` require a valid `token`. `cancel` does not.

## 10. Security / Authorization

- All organization endpoints require a valid session.
- Global users with `role === "admin"` bypass organization role checks.
- Default access rules:
  - `owner`: full access (manage org, members, invitations, delete).
  - `admin`: manage members + invitations, update org details.
  - `member`: read-only access and ability to leave.
- Access is granted if a member has **any** role in the allowed set.
- Do not allow removal or demotion of the last owner.
- Invitation acceptance must ensure the invitation is pending, the token matches, and it is not
  expired.

## 11. Limits & Validation

- Slug regex: `^[a-z0-9][a-z0-9-]{2,62}$` (default, configurable if needed).
- Name length: 1-120 characters.
- Invitation expiry default: 3 days.
- Enforce `limits.organizationsPerUser`, `limits.membersPerOrganization`,
  `limits.invitationsPerOrganization` when configured.

## 12. Operational Concerns

- Role assignments, membership creation, and invitation acceptance must be atomic.
- Durable hooks should be idempotent and safe to retry.
- Invitation token generation must be cryptographically random and unique.
- Member list queries should avoid N+1 patterns (use joins or batch role lookups).

## 13. Upgrade / Compatibility

- Existing auth behavior remains unchanged for sign-in/sign-up and sessions, except for `/me`
  payload expansion.
- Schema migration required for new tables and `session.activeOrganizationId`.
- `GET /me` retains existing fields and adds organization data for SPA bootstrap.
- `sendEmail` removed from `AuthConfig`; use hooks instead.

## 14. Decisions (locked)

- Organizations are enabled by default unless `AuthConfig.organizations === false`.
- Roles are defined in code only; no permissions are stored by the fragment.
- Members can have multiple roles.
- Active organization is stored on the session record.
- Role management endpoints are intentionally omitted.
- Organization deletion is a soft delete.
- Invitation acceptance is token-based and does not require email matching.
- Teams and external provisioning are out of scope for this iteration.

## 15. Documentation updates

- Add auth organization docs under `apps/docs/content/docs/auth/`.
- Update `packages/auth/test.md` with organization and `/me` examples.

## 16. Testing requirements

- Service tests for org creation, role assignments, invitations, and member management.
- Route tests for each endpoint (success + permission errors).
- Hook tests verifying `uow.triggerHook` for user and org lifecycle events.
- Pagination tests for organization/member/invitation listing.
- `/me` response tests for SPA bootstrap data.
- Auto-create org on user creation tests (single transaction behavior).
