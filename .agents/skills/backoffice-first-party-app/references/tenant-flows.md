# Tenant flows

Read the [provisioning contract](../../../../packages/backoffice-api/src/v0/provisioning.ts) for
exact inputs and results, and the
[Backoffice provisioning router](../../../../apps/backoffice/app/backoffice-api/provisioning-router.ts)
for cross-service behavior. The client uses `POST /api/v0/provisioning/<operationId>` with the app's
client-credentials OAuth token, not an execution token or a scope argument.

The current operations are `organizations.provision`, `projects.provision`, `invitations.create`,
`invitations.send`, and `invitations.accept`. The earlier hidden-user provisioning and
membership-sync design was replaced: users now sign in through Backoffice, and Backoffice owns
membership. Use the current contract rather than resurrecting those historical endpoints.

## Create a tenant

[Bookkeeping's wizard](../../../../apps/bookkeeping/workers/workflows/create-workspace.ts) asks for
the business name, then:

1. Calls `organizations.provision` with a stable `externalOrganizationId`, the organization name,
   and `ownerUserId` from the signed-in user's Backoffice subject.
2. Receives Backoffice's `organizationId` and slug. Backoffice has created the organization,
   installed the calling app with its requested permissions owner-wide, and claimed that
   installation for the external identifier.
3. Records the returned organization as the local workspace and its confirmed owner membership.

The owner must already have authorized this app's OAuth client. The app secret is not permission to
impersonate an arbitrary Backoffice user. Sign-up itself creates no organization; provisioning is an
explicit product onboarding action.

Use one stable external identifier across retries, including failures between remote provisioning
and local persistence. Backoffice derives identities from the app and external identifier; consume
the returned IDs instead of reproducing its hashing algorithm. A retry resumes partial work, not a
cross-service transaction. Uninstall wins: reprovisioning an explicitly uninstalled organization
returns conflict instead of reinstalling it.

For a multi-step wizard, run Fragno Workflows in the app. Bookkeeping mounts the fragment in a
separate [Workflows Durable Object](../../../../apps/bookkeeping/workers/workflows/workflows.ts),
waits durably for answers, and uses the workflow instance ID as the external organization ID. Retry
unknown outcomes with the same ID; surface explicit refusals. Preserve answers across retries and
make late duplicate submissions after completion return the finished destination.

For **linking an existing organization** instead of creating one, read the app-initiated install and
claim flow in
[Auth's README](../../../../apps/backoffice/app/fragno/auth/README.md#app-initiated-installation).
The owner selects it on Backoffice's install page; verify callback state before the server redeems
the claim code. First-party trust skips permission review, not owner selection or management
authority. This branch is separate from new-tenant provisioning.

## Confirm access by pulling authority

Read [the access boundary](../../../../apps/bookkeeping/app/workspace/access.server.ts) and its
[scenarios](../../../../apps/bookkeeping/app/workspace/access.scenario.test.ts). Keep a read-only
projection keyed by Backoffice organization and user IDs. For each protected request:

1. Require the local session and resolve the target workspace.
2. Trust membership only within its explicit confirmation lifetime. Bookkeeping uses 60 seconds,
   which is also its maximum stale local-access window after removal.
3. Once stale or absent, obtain the user's OAuth token, exchange for that organization's execution
   credential, and call `org.get` as that user to refresh organization details and roles.
4. On confirmed scope refusal, remove the cached membership and deny access (Bookkeeping uses 404).
   Preserve domain data. On outage, return 503 for unconfirmed access; neither extend stale
   authority nor delete membership merely because the service is unreachable.

Adopt Backoffice's owner/admin/member roles unless the product explicitly needs additional local
authorization. Enforce product-specific management rules in server actions, not just hidden UI.
Bookkeeping lets all members read books and only owners/admins invite or create administrations. Its
provisioning project endpoint verifies an authorized member, so the stricter product manager rule
belongs in the app.

Use `org.members.list` as the viewer and follow its cursors to refresh member listings. A local
projection is not automatically a global directory of every Backoffice organization. Bookkeeping
starts with organizations it created or knows, and invitations sent through the app. If discovery of
externally installed tenants or external invitations is required, design that read path explicitly;
do not claim the cache already supplies it.

This is pull-based confirmation, not webhook replication. Keep that simpler boundary until a product
requirement demands push delivery. Fresh local membership can remain usable during an outage only
until the stated confirmation deadline; scoped API operations still enforce their own live
Backoffice authority.

## Add project-backed domain objects only when needed

[Administration creation](../../../../apps/bookkeeping/app/administrations/new.tsx) illustrates the
mapping, not a mandatory feature for every app:

1. Authorize the product action and choose an external object ID that survives resubmission.
2. Call `projects.provision` with `organizationId`, `externalProjectId`, name, and the session's
   Backoffice `createdByUserId`.
3. Initialize domain storage using the returned project ID, then record the local object. Make local
   initialization and persistence idempotent too.

Project identity is scoped by app, organization, and external identifier. The app owns which
projects represent its domain objects. A project created elsewhere in Backoffice is not implicitly
one of them. Decide rename/deletion behavior explicitly: Bookkeeping does not propagate a remote
project rename/deletion into its administration record.

## Invite and accept through Backoffice

Read [members](../../../../apps/bookkeeping/app/workspace/members.tsx) and
[invitation acceptance](../../../../apps/bookkeeping/app/invitations/invitation.tsx):

1. As the app, call provisioning `invitations.create` with the organization, the signed-in inviter's
   Backoffice subject as `inviterUserId`, the email, and the roles. Backoffice requires the inviter
   to be a member who authorized the app and applies their live role: owners and admins invite, only
   owners invite owners. Scoped `org.invitations.create` needs `org.manage`, which apps never hold.
   Inviting the same address with the same roles again returns the pending invitation, so store it
   idempotently; other roles answer `409`. Keep the returned invitation for the app's acceptance
   page.
2. As the app, call provisioning `invitations.send` with the invitation ID and an acceptance URL on
   the origin of `branding.homeUrl`. Backoffice sends the branded email; repeated sends of that
   invitation do not send another email. If delivery is unavailable, show an explicit failure and
   the existing shareable link rather than reporting that email succeeded.
3. Preserve that destination through sign-in. Submit `invitations.accept` with the invitation ID and
   the authenticated Backoffice subject, using the app's provisioning token.
4. Let Backoffice verify the invited address, verified-email status, authorization, and active
   installation. Use the returned membership and confirm access on entry.

Membership comes from acceptance, never from a local insert or an email match. Wrong-user,
expired/conflicting, and unavailable-service outcomes must stay distinct. Repeated acceptance of an
already accepted invitation is supported by the contract; the UI may already have removed its local
invitation after success.
