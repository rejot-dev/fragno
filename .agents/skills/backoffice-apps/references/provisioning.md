# Provisioning

First-party apps only: each operation needs the provisioning permission of the same name in the
app's first-party trust. Read the
[provisioning contract](../../../../packages/backoffice-api/src/v0/provisioning.ts) for exact inputs
and results, and the
[Backoffice provisioning router](../../../../apps/backoffice/app/backoffice-api/provisioning-router.ts)
for cross-service behavior. `createBackofficeProvisioningClient` calls
`POST /api/v0/provisioning/<operationId>` with the app's client-credentials OAuth token, not an
execution token or a scope argument.

The operations are `organizations.provision`, `organizations.provisionForInvitee`,
`organizations.provisionManaged`, `organizations.listManaged`, `projects.provision`,
`invitations.create`, `invitations.send`, and `invitations.accept`. Users sign in through
Backoffice, and Backoffice owns membership; provisioning never creates users or edits membership
directly. Linking an organization that already exists is the install and claim flow in
[tenancy](tenancy.md), not provisioning.

## Create a tenant

Bookkeeping's tenants come in layers: its operators create accounting firms, and a firm's owners and
admins create its clients.
[Its provisioning](../../../../apps/bookkeeping/app/organizations/provision.server.ts) serves both:

1. Calls `organizations.provision` for a firm, or `organizations.provisionManaged` for a client,
   with a stable `externalOrganizationId`, prefixed with the kind so two kinds never share one, and
   the organization name. A firm names its owner with `ownerUserId`, the signed-in user's Backoffice
   subject. A client names its firm as `managingOrganizationId`, the signed-in firm owner or admin
   as `byUserId`, and `owner: { kind: "none" }`.
2. Receives Backoffice's `organizationId` and slug. Backoffice has created the organization,
   installed the calling app with its requested permissions owner-wide, and claimed that
   installation for the external identifier.
3. Records the returned organization with its kind and, for a client, its firm, and for a firm the
   creator's confirmed owner membership.

A managed organization's managing organization's members act in it with their role there, owners as
admins, without becoming its members: a firm's members open every client, and `org.get` says whether
someone acts `through` membership or the `managing-organization`. Record that, so lists of someone's
own organizations and an organization's members leave the managers out. Backoffice's administrator
may end management or change the manager, and Backoffice tells apps nothing when it does: follow
`org.get`'s `managingOrganization` whenever you confirm someone, and list a manager's organizations
with `organizations.listManaged`, which reaches those with no member of their own. Management does
not chain and never reaches installations. Operators are the members of an operator organization,
which Backoffice's administrator creates with
[the setup script](../../../../apps/bookkeeping/scripts/connect-backoffice.ts) and the app confirms
like any other membership. Don't keep an allowlist of user IDs in configuration: it can't be audited
in Backoffice, and changing it needs a deployment. Bookkeeping's operators manage no firms, because
managing a firm would reach its agent project and the firm's own skills.

The owner must already have authorized this app's OAuth client. The app secret is not permission to
impersonate an arbitrary Backoffice user. Sign-up itself creates no organization; provisioning is an
explicit product onboarding action. To create an organization for someone who has not signed in yet,
as [Bookkeeping's new-firm page](../../../../apps/bookkeeping/app/operator/new-firm.tsx) does, call
`organizations.provisionForInvitee` with their email and the acting user, who must have authorized
the app. Backoffice creates the organization with no members and a pending owner invitation from the
acting user, who does not become a member; send it with `invitations.send` and accept it with
`invitations.accept` as any other. Provisioning it again returns the pending invitation, a new one
once it expired, or none once the owner accepted. Don't provision with the acting user as owner and
invite the real owner: apps cannot remove members, so the acting user would stay an owner.

Use one stable external identifier across retries, including failures between remote provisioning
and local persistence. Backoffice derives identities from the app and external identifier; consume
the returned IDs instead of reproducing its hashing algorithm. A retry resumes partial work, not a
cross-service transaction. Uninstall wins: reprovisioning an explicitly uninstalled organization
returns conflict instead of reinstalling it.

A single form carries an external ID chosen when it was shown, so resubmitting it after a failure
finds what the first submission made. For a multi-step wizard, run Fragno Workflows in the app, wait
durably for answers, and use the workflow instance ID as the external organization ID. Retry unknown
outcomes with the same ID; surface explicit refusals. Preserve answers across retries and make late
duplicate submissions after completion return the finished destination.

## Add project-backed domain objects only when needed

[Administration creation](../../../../apps/bookkeeping/app/administrations/new.tsx) illustrates the
mapping, not a mandatory feature for every app:

1. Authorize the product action and choose an external object ID that survives resubmission.
2. Call `projects.provision` with `organizationId`, `externalProjectId`, name, and the session's
   Backoffice `createdByUserId`, a member of the organization or of the one managing it.
3. Initialize domain storage using the returned project ID, then record the local object. Make local
   initialization and persistence idempotent too.

Project identity is scoped by app, organization, and external identifier. The app owns which
projects represent its domain objects. A project created elsewhere in Backoffice is not implicitly
one of them. Decide rename/deletion behavior explicitly: Bookkeeping does not propagate a remote
project rename/deletion into its administration record.

## Invite and accept through Backoffice

Read [members](../../../../apps/bookkeeping/app/members/members.server.ts),
[inviting](../../../../apps/bookkeeping/app/invitations/invite.server.ts), and
[invitation acceptance](../../../../apps/bookkeeping/app/invitations/invitation.tsx):

1. As the app, call provisioning `invitations.create` with the organization, the signed-in inviter's
   Backoffice subject as `inviterUserId`, the email, and the roles. Backoffice requires the inviter
   to act in the organization, as a member or through its managing organization, and to have
   authorized the app, and applies their live role: owners and admins invite, only owners invite
   owners, and while a managed organization has no owner its manager's owners and admins invite one.
   Scoped `org.invitations.create` needs `org.manage`, which apps never hold. Inviting the same
   address with the same roles again returns the pending invitation, so store it idempotently; other
   roles answer `409`. Keep the returned invitation for the app's acceptance page.
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
