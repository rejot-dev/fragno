# Tenancy

Read
[installed-app execution](../../../../apps/backoffice/app/fragno/apps/README.md#installed-app-execution)
and the
[install and claim contract](../../../../apps/backoffice/app/fragno/auth/README.md#app-initiated-installation).

## Choose the tenancy

An app reaches a Backoffice owner only through an active **installation** there. Owners are root
scopes:

- **An organization** (`org:<orgId>`): the app acts for its members, or as the installation.
- **A person** (`user:<userId>`), who installed the app for themselves: the app acts for that person
  only.

The owner approves which **resources** the installation reaches: everything it has
(`{ kind: "owner" }`), or selected projects it owns (`{ kind: "projects", projectIds }`). Exchange
for a project scope when only projects were approved; the owner's own scope is then unavailable.

Every installation also gives the app a private **workspace**, `app:<owner>:<appId>`, for its data
about that owner: store entries, files, events, routes, and workflows. Only the app's credentials
reach it, whatever resources were approved; the owner's members read it but cannot change it. Its
data survives uninstalling, so a reinstall picks up where the app left off. An app's UI “workspace”
is not necessarily this scope.

Bookkeeping's tenants are organizations only. Choose kinds from the product's needs; a product that
serves individuals can rely on personal installations.

## Link an owner: install and claim

An owner links an existing organization, or themselves, to one of the app's own tenants:

1. The app's server redirects to
   `<Backoffice>/backoffice/apps/install?client_id&redirect_uri&state`. `redirect_uri` shares an
   origin with one of the client's registered OAuth redirect URIs; `state` is bound to the app's
   session and the tenant being linked.
2. The person picks an organization they own or administer, or themselves. What they approve next
   depends on the trust: a third-party app's permissions, resources, and actions are reviewed; a
   first-party app's installation gets every requested permission over everything the owner has.
3. Backoffice redirects to `redirect_uri?code&state`, or `?error=access_denied&state` when they
   cancel. Verify `state` before anything else, so a code cannot be injected into another person's
   flow.
4. The server claims the installation with its client-credentials token:
   `POST /api/backoffice/app-installations/claim` with `{ code, externalAccount: { id, label } }`.
   The code is a five-minute, single-app proof of one activation's approval.
5. Record the returned installation: `owner`, `grantedPermissions`, `resourceScope`, and
   `activation`, keyed by the app's tenant ID. Apps cannot read installations through `apps.*`
   later, so the claim result is the app's record of them.

An installation links at most one external account. Claiming the same account again refreshes its
label; another account answers `409 app_installation_already_claimed` until the owner uninstalls,
which clears the link. `409 app_installation_activation_stale` and `409 app_installation_inactive`
mean a reinstall or uninstall overtook the approval: send the owner through the install page again.

**Complete when:** a linked tenant maps to exactly one installation, a cancelled or forged callback
links nothing, and a second claim for a different tenant is refused.

## Confirm access by pulling authority

Read [the access boundary](../../../../apps/bookkeeping/app/organizations/access.server.ts) and its
[scenarios](../../../../apps/bookkeeping/app/organizations/access.scenario.test.ts). Keep a
read-only projection keyed by Backoffice owner and user IDs. For each protected request:

1. Require the local session and resolve the target tenant, refusing one of another kind than the
   route serves.
2. Trust membership only within its explicit confirmation lifetime. Bookkeeping uses 60 seconds,
   which is also its maximum stale local-access window after removal.
3. Once stale or absent, obtain the user's OAuth token, exchange for that organization's execution
   credential, and call `org.get` as that user to refresh organization details and roles.
4. On confirmed scope refusal (removal, uninstall, or resources that no longer include the target),
   remove the cached membership and deny access (Bookkeeping uses 404). Preserve domain data. On
   outage, return 503 for unconfirmed access; neither extend stale authority nor delete membership
   merely because the service is unreachable.

Adopt Backoffice's owner/admin/member roles unless the product explicitly needs additional local
authorization. Enforce product-specific management rules in server actions, not just hidden UI.
Bookkeeping lets all members read books and only owners/admins invite or create administrations.

Use `org.members.list` and `org.invitations.list` as the viewer and follow their cursors to refresh
member listings. Installed apps cannot ask which organizations someone belongs to, so the projection
holds only what the app learned itself: tenants it provisioned or claimed, invitations it sent, and
confirmed visits. If discovery of other tenants is required, design that read path explicitly; do
not claim the cache already supplies it.

This is pull-based confirmation, not webhook replication. Keep that simpler boundary until a product
requirement demands push delivery. Fresh local membership can remain usable during an outage only
until the stated confirmation deadline; scoped API operations still enforce their own live
Backoffice authority.
