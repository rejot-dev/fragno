# Auth organization snapshot review findings

Reviewed path: `./packages/auth/src/organization` Date: 2026-04-15 Verdict: **needs attention**

## Fix status update

Fixed on 2026-04-15:

- ✅ **[P1] Regular members can list invitation tokens and invitee details**
  - `GET /organizations/:organizationId/invitations` now requires the same elevated organization
    permissions as invite creation/cancellation.
  - Updated files:
    - `packages/auth/src/organization/invitation-services.ts`
    - `packages/auth/src/organization/organization-routes.test.ts`
- ✅ **[P1] Soft-deleted organizations remain mutable through session-backed update/delete flows**
  - Session-backed update/delete now treat soft-deleted organizations as `organization_not_found`.
  - The core non-session update/delete service paths were aligned to the same active-organization
    invariant.
  - Updated files:
    - `packages/auth/src/organization/organization-services.ts`
    - `packages/auth/src/organization/organization-routes.test.ts`
    - `packages/auth/src/organization/organization-services.test.ts`
- ✅ **[P3] Invalid cursors are silently treated as first-page requests**
  - Organization and member list routes now reject malformed or incompatible cursors with
    `invalid_input` instead of silently falling back to page 1.
  - Updated files:
    - `packages/auth/src/organization/routes.ts`
    - `packages/auth/src/organization/organization-routes.test.ts`

Still open:

- ⏳ **[P2] Session organization pagination can hide later organizations for multi-role
  memberships**
- ⏳ **[P2] Invitation email casing is handled inconsistently**

## Findings

### [P1] Regular members can list invitation tokens and invitee details

- **Files:** `packages/auth/src/organization/invitation-services.ts:1172-1180`,
  `packages/auth/src/organization/routes.ts:773-809`
- The organization invitations read path only checks that the caller is a member of the
  organization, not that they can manage invitations.
- Because the route returns `invitationSchema`, any regular member can enumerate pending invitee
  emails, assigned roles, and invite tokens for the org.
- This is a real permission leak on `GET /organizations/:organizationId/invitations` and is
  inconsistent with the create/cancel paths, which do require admin/owner privileges.

### [P1] Soft-deleted organizations remain mutable through session-backed update/delete flows

- **Files:** `packages/auth/src/organization/organization-services.ts:1424-1485`,
  `packages/auth/src/organization/organization-services.ts:1575-1612`
- The session-backed update/delete mutations only check `!organization`, not
  `organization.deletedAt`.
- After an organization is soft-deleted, its membership rows are still present, so the same member
  can continue to `PATCH /organizations/:organizationId` and `DELETE /organizations/:organizationId`
  successfully against a resource that all read paths already treat as not found.
- This makes soft-deleted organizations still mutable and can retrigger destructive side
  effects/hooks on supposedly deleted data.

### [P2] Session organization pagination can hide later organizations for multi-role memberships

- **Files:** `packages/auth/src/organization/organization-services.ts:908-912`,
  `packages/auth/src/organization/organization-services.ts:994-1003`
- `getOrganizationsForSession` paginates `sessionMembers` after joining roles, then deduplicates
  rows in memory.
- For members with multiple roles in the same org, the `pageSize + 1` fetch can be consumed entirely
  by duplicate rows for one membership, so `orderedEntries.length` drops back to `pageSize` and
  `hasNextPage` becomes false even when more organizations exist.
- In practice, `GET /organizations?pageSize=...` can hide later orgs for users who have 2+ roles in
  an org.

### [P2] Invitation email casing is handled inconsistently

- **Files:** `packages/auth/src/organization/invitation-services.ts:311-313`,
  `packages/auth/src/organization/invitation-services.ts:391-394`,
  `packages/auth/src/organization/invitation-services.ts:474-479`
- Duplicate invites are detected case-insensitively with `normalizeEmail(...)`, but invitations are
  stored with the original casing and later queried by exact `email = ...`.
- That means inviting `Alice@Example.com` and then looking up invitations for `alice@example.com`
  can miss the row entirely.
- Since accept/reject already compares emails case-insensitively, this appears unintentional and
  will make invitation discovery flaky when invitees or callers normalize email casing.

### [P3] Invalid cursors are silently treated as first-page requests

- **Files:** `packages/auth/src/organization/routes.ts:33-41`
- `parseCursor` swallows `decodeCursor` failures and returns `undefined`, which the list handlers
  then interpret as “start from page 1.”
- A malformed or stale `cursor` therefore produces a successful response with duplicate first-page
  data instead of `invalid_input`, which can trap clients in pagination loops and hides a real
  request error at the boundary.

## Human Reviewer Callouts (Non-Blocking)

- (none)
