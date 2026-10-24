# Third-party apps

A third-party app is one Backoffice does not operate, and every registration's default. People and
owners decide what it may do: each person reviews its OAuth request and can revoke it, and each
owner reviews its permissions, resources, and actions when installing it and can narrow them later.
A system administrator still registers it. Read
[apps and installations](../../../apps/backoffice/app/fragno/apps/README.md) and
[installed apps](../../../apps/backoffice/app/fragno/auth/README.md#installed-apps).

## Declare the trust (step 2)

Register with `trust: { kind: "third-party" }`, which `admin.apps.create` defaults to. It carries no
branding and no provisioning permissions.

- **Requested permissions are a ceiling the owner reviews.** Changing them never changes an
  installation: an added permission applies once an owner grants it, through the install page or
  `apps.installations.update`; a removed one stays granted until an owner changes the installation's
  access.
- **Actions** use `changeApproval: "installation"`. A changed declaration then waits: each
  installation keeps calling the revision it approved until an owner approves the new one, with
  `apps.installations.approve-actions` or by passing through the install page again.

## Sign-in and consent (step 2)

People sign in on Backoffice's own login page, with an existing Backoffice account; the app cannot
sign up new people, and Backoffice's own sign-up may require an invitation. Say so in the app's
sign-in copy.

The consent page shows the signed-in account, the client's name, the requested OAuth scopes, and the
callback, and the person approves or denies. Handle a denial at the callback as a cancelled sign-in.
People revoke the app at Authorized applications, which deletes its tokens for them: the next token
refresh fails and the exchange answers 401, so the app asks them to sign in again. Widening the
client's OAuth scopes also needs every person to authorize again.

**Sign-in criterion:** an existing Backoffice user approves once and returns signed in with the
correct subject; denial and revocation each lead back to sign-in without a stuck session.

## Tenants (step 4)

An owner links each tenant through the install and claim flow in [tenancy](references/tenancy.md);
there is no provisioning. The owner reviews what to grant and may approve less than the app
requests, or only some projects, and may narrow either later:

- Read what was granted from the claim result, and design features to degrade to it. An operation
  outside the grants answers `403 forbidden`; an exchange for a scope outside the approved resources
  answers `403 scope_unavailable`.
- To ask for more, send an owner through the install page again and claim the result.
- An uninstalled installation refuses every exchange. Keep the tenant's domain data and offer to
  link again: a reinstall is a new activation the app claims again.

## Scenarios (step 5)

There is no third-party reference app; adapt Bookkeeping's harness. Extend Backoffice's
[installed-app scenarios](../../../apps/backoffice/app/backoffice-api/installed-app.scenario.test.ts),
which drive an app with default trust through authorization, the install page, claims, grant
changes, revocation, and reinstallation, and its
[consent scenarios](../../../apps/backoffice/app/routes/backoffice/oauth-consent.scenario.test.tsx)
for changes to Backoffice itself. In the app, also cover:

- Consent denial and revocation return the person to sign-in.
- An owner who grants fewer permissions or only some projects gets a working app within them.
- Uninstall, then reinstall and claim, restores access to the same tenant.
- A changed action declaration runs only after the owner approves it.

For a quick identity-only check of a client against a local Backoffice, run the loopback test client
described in
[testing an OAuth client](../../../apps/backoffice/app/fragno/apps/README.md#test-an-oauth-client-with-a-local-callback-server).
