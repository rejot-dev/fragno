# Backoffice apps and organization installations

Two fragments separate global registration from customer-owned installation authority:

| Fragment            | Durable Object                           | Scope        | Owns                                                            |
| ------------------- | ---------------------------------------- | ------------ | --------------------------------------------------------------- |
| `apps`              | `APPS` / `Apps`                          | Singleton    | App registration, OAuth client reference, requested permissions |
| `app-installations` | `APP_INSTALLATIONS` / `AppInstallations` | Organization | Installation lifecycle, approved grants, installer attribution  |

Both directories use `contracts.ts`, `schema.ts`, `definition.ts`, `fragment.ts`, and `server.ts`.
The registry's `permissions.ts` and `errors.ts` own the shared permission set semantics and
serializable operation failures. There are no forwarding modules.

## Bash output

All four admin app and OAuth commands produce readable text by default; `--format text` selects the
same output explicitly. Creation reports the resulting ID and whether an app registration was new or
already present. Lists show record metadata, whether more results exist, and the next cursor. Empty
app catalogs are reported explicitly.

`--format json` keeps the structured result unchanged. `--print <field>` still selects a field from
that result instead of rendering the text summary, including nested selectors such as
`--print apps.0.id` or `--print clients.0.clientId`.

Confidential OAuth creation displays the initial secret in text output, with a secure-storage
reminder, just as JSON output returns it. Public creation explicitly reports that no secret exists.
OAuth listing never displays credentials. Creation tool-call records remain redacted in either
format, but actual stdout contains credentials; do not capture it in unrelated logs.

```bash
admin.oauth-clients.list
admin.apps.list --format text
admin.apps.create --oauth-client-id existing-client-id --requested-permissions-json '[]' --print appId
```

## Ownership and trust

Better Auth remains authoritative for OAuth clients, publisher ownership, client metadata, redirect
URIs, credentials, users, and organizations. Registry registration accepts an already-provisioned
client ID; the primitive RPC does not provision or verify that client in Auth. The admin app
creation tool checks client existence through Auth before invoking registration.

Publisher organizations and customer organizations are distinct. A publisher reference must never be
interpreted as the organization where an app is installed.

Installations belong to the organization encoded in the Durable Object identity. RPC inputs have
**no organization ID**. The fragment receives its organization from object scope and stamps it into
new rows; it is also part of the pagination index, preventing cursors from crossing organization
objects.

The installation's `appId` is an external registry reference, not a foreign key into the
organization's database. Installer IDs refer to Auth-owned users. Trusted command callers must
establish Auth identities and management authority before calling either object.

Neither fragment exposes HTTP routes. System admin runtime tools expose OAuth client provisioning,
app registration, and listing. Organization runtime tools expose declaration review and installation
management. An installed app can act for a signed-in organization member through an app-bound
credential (see below). Ordinary developer registration and app-only background execution remain
outside this scaffold. Marketplace packages remain independent.

## System admin OAuth client tools

`admin.oauthClientsCreate` / `admin.oauth-clients.create` requires `admin.oauth-clients.manage`,
System context, and an administrator user principal. The OAuth client belongs to that Auth user;
callers cannot choose or forge its owner. Metadata, redirects, and credentials stay exclusively in
Auth.

```ts
const client = await admin.oauthClientsCreate({
  name: "Accounting",
  redirectUris: ["https://accounting.example/callback"],
  scopes: ["openid", "profile", "email", "offline_access", "backoffice"],
  clientType: "confidential",
  clientCredentials: true,
});
// Store the initial confidential client secret securely before discarding this response.
await admin.appsCreate({
  oauthClientId: client.clientId,
  requestedPermissions: [{ namespace: "events", permission: "emit" }],
});
```

```bash
admin.oauth-clients.create --name Accounting \
  --redirect-uri https://accounting.example/callback \
  --scope openid --scope profile --scope email --scope offline_access --scope backoffice \
  --client-credentials --format json
```

`admin.oauthClientsUpdate` / `admin.oauth-clients.update` replaces a client's redirect URIs, OAuth
scopes, and client-credentials access; all three are required, so nothing changes implicitly.
`admin.oauthClientsRotateSecret` / `admin.oauth-clients.rotate-secret` replaces a confidential
client's secret, returning the new one once; the previous secret stops working immediately. Both
require `admin.oauth-clients.manage` and act as the calling administrator: Better Auth allows only
the client's owner to change it, and the deployment's Codemode client cannot be changed at all.
Widening scopes does not widen existing consents; users authorize again.

```bash
admin.oauth-clients.update --client-id CLIENT_ID \
  --redirect-uri https://accounting.example/callback \
  --scope openid --scope backoffice --client-credentials
admin.oauth-clients.rotate-secret --client-id CLIENT_ID
```

`admin.oauthClientsList` / `admin.oauth-clients.list` requires `admin.oauth-clients.read` and the
same System administrator user context. It reads the **global** Auth client catalog, including other
administrators' clients and the deployment Codemode client, rather than only the caller's clients.
Output is `{ clients, nextCursor, hasNextPage }`, with client IDs, names, redirects, scopes,
authentication methods, owner references, and disabled flags; no credentials or credential hashes
are selected or returned. Pages default to 25 clients, allow 1–100, and use ascending client-ID
cursor pagination. Resume with the same page size.

```ts
const page = await admin.oauthClientsList({ pageSize: 25, cursor: null });
```

```bash
admin.oauth-clients.list --page-size 25 --format json
```

These are authorization-code clients with PKCE required. `applicationType` / `--application-type`
selects `web` (the default) or `native`. This is independent of `clientType` / `--client-type`:
confidential clients (the default) use `client_secret_basic` and return their initial secret; public
clients use `none` and return `clientSecret: null`. Native clients permit HTTP loopback callbacks;
web clients require HTTPS callbacks on non-loopback hosts. Neither application type enables the
device-code grant through this tool. Refresh-token support is added when `offline_access` is
requested. `clientCredentials` / `--client-credentials` additionally allows the `client_credentials`
grant for the `backoffice` scope only, letting an installed app act as its installation; it requires
a confidential client with the `backoffice` scope. Supported OAuth scopes are defined by
`BACKOFFICE_OAUTH_SCOPES` in `auth/oauth-client.ts`; they are not app capability declarations or
organization installation grants. The shared Backoffice execution token exchange grants first-party
user authority only to the deployment's Codemode client. A registered app's client receives an
app-bound credential instead; see [Installed-app execution](#installed-app-execution) and
[`../auth/README.md`](../auth/README.md) for the shared execution flow.

OAuth client creation is **not idempotent** and does not register or install an app. Creating a
client and registering its app are explicit independent operations, with no cross-object
transaction. Secret-bearing results are redacted in Codemode and Bash tool-call records, but the
authorized caller still receives credentials in the actual output; avoid copying them into unrelated
logs.

Managed Better Auth client operations also check live global administrator status, including banned
status, rather than relying on cached session roles. Dynamic client registration stays disabled. The
internal Codemode bootstrap remains supported and cannot use its synthetic identity for other client
management actions. Server-side provisioning uses an isolated Auth instance so its synthetic session
cannot leak into concurrent HTTP requests.

## Test an OAuth client with a local callback server

`scripts/test-oauth-client.mjs` is a small, loopback-only OAuth client, not another Backoffice
server. It exercises authorization code + S256 PKCE, verifies the ID token through Backoffice's JWKS
(signature, issuer, audience, expiry, and nonce), then calls userinfo and checks its subject. The
result page displays identity and token metadata, **not tokens or secrets**. Credentials are not
persisted or logged. Stop the server with Ctrl+C.

### 1. Start Backoffice and sign in

From the repository root:

```bash
pnpm --filter @fragno-apps/backoffice-rr dev
```

Open `http://127.0.0.1:5173/backoffice/login` and sign in as a **global administrator** in the
browser where you will test OAuth. Use an existing account and the usual development setup; the test
script neither provisions users nor bypasses email verification/invitations. If your Backoffice runs
at another origin, use that origin consistently and pass it with `--backoffice-url` below.

Use the **exact Backoffice origin open in your browser** for `--backoffice-url`: `localhost` and
`127.0.0.1` do not share session cookies. Client creation requires a global administrator; approving
authorizations and managing your own consents do not. Password login resumes the provider's signed
OAuth request when starting the test signed out.

### 2. Create a dedicated public native client

Use this exact local test profile:

| Setting               | Value                            |
| --------------------- | -------------------------------- |
| Name                  | `Local OAuth PKCE Test`          |
| Application type      | `native`                         |
| Client authentication | `none` (public; no secret)       |
| Grant types           | `authorization_code`             |
| Redirect URI          | `http://127.0.0.1:8789/callback` |
| Scopes                | `openid profile email`           |
| PKCE                  | Required; the script uses S256   |

**Do not use the deployment Codemode client.** This is a native authorization-code test client, not
a device-code client. Better Auth rejects HTTP loopback redirects for `web` clients; native clients
allow this callback. Create it through the runtime tool in the **Backoffice terminal with System
context**, as a global administrator (this command is not a host-shell command):

```bash
admin.oauth-clients.create --name "Local OAuth PKCE Test" --application-type native --client-type public --redirect-uri http://127.0.0.1:8789/callback --scope openid --scope profile --scope email
```

Or use Codemode in the same System administrator context:

```ts
const localOAuthClient = await admin.oauthClientsCreate({
  name: "Local OAuth PKCE Test",
  applicationType: "native",
  clientType: "public",
  redirectUris: ["http://127.0.0.1:8789/callback"],
  scopes: ["openid", "profile", "email"],
});
```

Copy the returned client ID. Creating a client is not idempotent; keep that ID and reuse it instead
of creating a new client for every run. No app registration or organization installation is required
for this identity-only test.

### 3. Run the local client

From the repository root, in another terminal:

```bash
pnpm --filter @fragno-apps/backoffice-rr oauth:test --client-id 'CLIENT_ID_FROM_STEP_2' --backoffice-url http://127.0.0.1:5173
```

Open `http://127.0.0.1:8789` (use **127.0.0.1**, not localhost) and click **Start OAuth login**. The
default port is 8789. If you pass `--port 8790`, provision the client with
`http://127.0.0.1:8790/callback` instead. The script uses Backoffice's existing `/api/auth/oauth2/*`
endpoints and `/api/auth/jwks`, with the configured Backoffice origin as issuer. Root OIDC discovery
is not mounted yet; the script does not require it.

For a separately provisioned confidential native test client using `client_secret_basic`, the script
also accepts `OAUTH_CLIENT_SECRET` in its environment. Do not put a secret in command-line arguments
or commit it. The public profile above needs no secret; unset `OAUTH_CLIENT_SECRET` if it was
previously set. HTTPS web-client testing needs a different, HTTPS non-loopback callback setup.

```bash
pnpm --filter @fragno-apps/backoffice-rr oauth:test --help
```

### 4. Review and approve in Backoffice

The provider opens `/backoffice/oauth/consent?...`. Review your signed-in account, the client name
and ID, requested OAuth scopes, and callback URL, then choose **Approve** or **Deny**. Better Auth
validates the signed query and owns the callback redirect. No developer-console approval or
`skip_consent` is needed. Return to the local server and start again if the query expired.

Codemode continues to use `/backoffice/device`, with its device-code verification and first-party
access warning. Both approval screens share the design-system authorization presentation, but keep
their protocol-specific loaders/actions.

A successful callback shows **OAuth login succeeded** and the authenticated user's
subject/name/email. The script rejects missing/mismatched browser state, reused callbacks,
issuer/nonce mismatches, and failed exchanges. The test requests only identity scopes: it does not
exchange for a Backoffice execution token or enable organization capabilities.
Registering/installing this client would not change the current external-client execution
restrictions.

## Review and revoke personal OAuth authorizations

Open **Account menu → Authorized applications**, or **Settings → Authorized applications** at
`/backoffice/settings/authorized-applications`. This page requires a live browser session and shows
only that user's grants, including new Codemode device approvals, with client names, IDs, scopes,
and approval timestamps. It is not an organization installation-management page.

**Revoke access** deletes that user's consent, stored access tokens, refresh tokens, and pending or
approved device codes for the selected client. Live consent is checked when minting user OAuth
claims, serving userinfo, and exchanging an OAuth token for Backoffice execution. This prevents an
already-issued OAuth JWT from obtaining fresh execution credentials after revocation. Previously
issued self-contained tokens may still be usable by external verifiers until expiry; already-issued
Backoffice execution JWTs retain their existing maximum 15-minute lifetime.

Device approvals made before consent tracking was added must be repeated once; there is no inferred
or automatic consent backfill. Reauthorizing after revocation requires a new explicit approval.

## System admin app runtime tools

`admin.appsCreate` / `admin.apps.create` requires the canonical `admin.apps.manage` permission.
`admin.appsList` / `admin.apps.list` requires `admin.apps.read`. Both use the existing authorization
kernel and require System context; they are unavailable in organization, project, and user contexts.
No grants are added to ordinary user or organization-member roles.

Creation registers an **existing** Better Auth OAuth client. It does not create credentials or
install the app. Repeating the same declaration returns the same app ID with `created: false`;
changing a declaration through repeated creation fails explicitly.

```ts
await admin.appsCreate({
  oauthClientId: "existing-client-id",
  requestedPermissions: [{ namespace: "events", permission: "emit" }],
});
const page = await admin.appsList({ pageSize: 25, cursor: null });
```

```bash
admin.apps.create --oauth-client-id existing-client-id \
  --requested-permissions-json '[{"namespace":"events","permission":"emit"}]' --format json
admin.apps.list --page-size 25 --format json
```

Registration requires an existing client that allows the `backoffice` scope. The deployment's
Codemode client is rejected: it always receives first-party authority, so an app registered for it
could never act as an app.

Listing defaults to 25 registrations, allows 1–100 per page, and returns `apps`, `nextCursor`, and
`hasNextPage`. Resume using the same page size. Output contains only registry data, never OAuth
credentials or organization installation grants.

## Organization installation runtime tools

Select an **organization context** in the Backoffice terminal or Codemode. The `apps` tool family is
unavailable in System, project, and user contexts. Organization identity comes from the selected
context and the installation object's scope, never from command input.

| Codemode method           | Bash command                | Permission    | Purpose                                            |
| ------------------------- | --------------------------- | ------------- | -------------------------------------------------- |
| `apps.get`                | `apps.get`                  | `apps.read`   | Review the global app declaration                  |
| `apps.getInstallation`    | `apps.installations.get`    | `apps.read`   | Inspect this organization's installation           |
| `apps.listInstallations`  | `apps.installations.list`   | `apps.read`   | List active and uninstalled installations          |
| `apps.install`            | `apps.install`              | `apps.manage` | Approve explicit permissions and resources         |
| `apps.updateInstallation` | `apps.installations.update` | `apps.manage` | Replace approved permissions and resources         |
| `apps.uninstall`          | `apps.uninstall`            | `apps.manage` | Clear grants and link; retain installation history |

Active organization members may review declarations and installations. Management additionally
requires an organization `owner` or `admin` role, or global administrator status **and membership in
that organization**. These permissions require an undelegated internal user principal; automation
services cannot approve installations. The kernel resolves app permissions from live Auth state,
including membership, organization roles, global role, and banned status. A still-valid user JWT or
reused tool context does not preserve installation authority after those rights are removed. This
live policy is specific to app management; unrelated operations retain their existing authority
policy and do not acquire an extra Auth lookup.

Review before approving:

```ts
const app = await apps.get({ appId: "APP_ID" });
// Review app.requestedPermissions; OAuth scopes are not installation permissions.
await apps.install({
  appId: "APP_ID",
  grantedPermissions: [{ namespace: "events", permission: "emit" }],
  resourceScope: { kind: "projects", projectIds: ["PROJECT_ID"] }, // default: whole organization
});
const page = await apps.listInstallations({ pageSize: 25, cursor: null });
await apps.updateInstallation({
  appId: "APP_ID",
  grantedPermissions: [],
  resourceScope: { kind: "organization" },
});
await apps.uninstall({ appId: "APP_ID" });
```

```bash
apps.get --app-id APP_ID
apps.install --app-id APP_ID \
  --granted-permissions-json '[{"namespace":"events","permission":"emit"}]'
apps.installations.get --app-id APP_ID --format json
apps.installations.list --page-size 25
apps.installations.update --app-id APP_ID --granted-permissions-json '[]' \
  --resource-scope-json '{"kind":"organization"}'
apps.uninstall --app-id APP_ID
```

Install and update inputs require an explicit permission array; `[]` approves no capabilities.
Resources are `{ "kind": "organization" }` or `{ "kind": "projects", "projectIds": [...] }` for
current, unarchived projects of the organization; install defaults to the whole organization, while
update requires both so access is never widened implicitly. Installer attribution comes from the
authenticated principal. Neither `installedByUserId` nor an organization ID is accepted from
callers. Duplicate install cannot change access or replace the installer; use the explicit update
command. Reinstallation retains installation identity, records the newly approving user, and
increments `activation`.

Lists default to 25 records, accept 1–100, and return `{ installations, nextCursor, hasNextPage }`.
Resume with the same organization and page size. Bash commands produce readable text by default;
`--format json` returns structured results and `--print installations.0.id` selects a nested field.
Declaration review returns registry metadata and requested permissions, never OAuth credentials.
Installation inspection, listing, and uninstall remain independent of registry availability;
approval and grant updates still require the authoritative declaration.

**Installation approval is not OAuth user consent.** It does not change OAuth scopes or create
credentials. It is the organization-side ceiling for
[installed-app execution](#installed-app-execution): the app may act only within the approved
permissions and resources, and when acting for a member, only within what that member may currently
do as well. Uninstall clears grants and any linked external account and immediately invalidates
app-bound credentials, but does not revoke personal OAuth authorizations.

## Installed-app execution

A registered app exercises its organization's approval either on behalf of a signed-in member or as
its installation:

1. An administrator creates the app's confidential OAuth client with the `backoffice` scope (plus
   identity scopes, `offline_access`, and client credentials as needed) and registers it.
2. An organization owner or admin installs it, approving permissions and resources: with the tools
   above, or through the app-initiated install page
   `/backoffice/apps/install?client_id&redirect_uri&state`, after which the app's server claims the
   installation for one of its own accounts.
3. The app's server obtains an OAuth access token for `resource=<Backoffice origin>`: through the
   authorization-code flow for a member, or the client-credentials grant for the installation.
4. It exchanges that token at `POST /api/backoffice/execution-token` with an organization or
   approved project scope, receiving a 15-minute app-bound credential.
5. It calls `POST /api/backoffice/scopes/:scopeSegment/events` with that credential.

Every protected operation resolves the installation live. Acting for a member requires the member's
current permissions **and** the installation's grants; acting as the installation requires its
grants. Either way the target must be inside the approved resources. Narrowing access, removing the
member, banning the user, or uninstalling affects already-issued credentials immediately. Each
reinstall increments `activation`; credentials and app-started work from an earlier activation never
revive. Installation management is never available to an app.

App-bound credentials have a distinct JWT audience and cannot be used where user credentials are
accepted. Events use source `app:<appId>` and persist actors that keep the app's restrictions for
automation started from them. See [`../auth/README.md`](../auth/README.md#installed-apps) for the
endpoint, install, and claim contracts, and `apps/bookkeeping` for an example app.

`app/fragno/runtime-tools/families/apps.scenario.test.ts` exercises both Codemode and Bash through
real Auth and installation SQLite storage, including approval lifecycle, authenticated attribution,
member versus manager authority, live revocation with request snapshots, strict inputs, organization
isolation, scope restrictions, and pagination after object restart.

## Commands and transaction boundaries

```ts
const registry = runtime.objects.apps.singleton().commands;
const installations = runtime.objects.appInstallations.forOrg(organizationId).commands;
```

| Object       | Command                                                      | Registry access                                           |
| ------------ | ------------------------------------------------------------ | --------------------------------------------------------- |
| Registry     | `registerApp`, `getApp`, `getAppByOAuthClientId`, `listApps` | Own local database                                        |
| Organization | `installApp`                                                 | Resolve declaration and projects before local transaction |
| Organization | `updateInstallationAccess`                                   | Resolve declaration and projects before local transaction |
| Organization | `claimInstallation`                                          | None                                                      |
| Organization | `getInstallation`, `listInstallations`, `uninstallApp`       | None                                                      |

Declarations are immutable and cannot be deleted in this scaffold. Installation setup and grant
updates fetch that authoritative declaration before opening the organization's transaction. There is
**no cross-object transaction or foreign key**. Declaration changes and global app disablement
require an explicit coordination policy before being added.

Routine authority reads, installation lists, and revocation remain local to the customer object.
They do not depend on registry availability. This is command-level independence; the single-process
Node host still restores known objects at startup, and its startup failure policy is not changed by
this split.

## Persistence invariants

- OAuth client references are unique in the global registry.
- Each organization database has at most one installation per app ID.
- Grants use canonical Backoffice permissions and cannot exceed the app declaration.
- Duplicate registration or installation cannot silently enlarge declarations or grants.
- Grant updates are explicit; duplicate install does not change installer attribution.
- Uninstall clears grants and the linked external account but retains identity. Reinstall reuses
  that identity, records the newly approved access and installer, and increments `activation`.
- An installation links at most one external account; linking a different one requires uninstalling.
- Resources are stored as `resourceProjectIds`: `null` is the whole organization (also what earlier
  installations approved), otherwise a non-empty project list.
- Installer membership removal does not delete an organization-owned installation.
- Local absence checks, row-version checks, and unique indexes guard concurrent mutations.
- All database reads precede mutation; timestamps come from database time.
- Registry cursors are bound to the primary index, direction, and page size. Installation cursors
  additionally bind the owning organization.

Domain failures return `{ ok: false, error: { code, message } }`. Invalid RPC input fails before
orchestration or domain services; unexpected infrastructure failures propagate.

`workers/app-installations.do.scenario.test.ts` exercises both production object behaviors through
real SQLite, including organization isolation, object and full-runtime restart, and local reads and
revocation after the real registry connection fails. New installation approvals and grant changes
fail closed during that outage.

`app/fragno/runtime-tools/families/admin-apps.scenario.test.ts` exercises both Codemode and Bash
against Auth and registry SQLite storage, including client existence, malformed declarations,
idempotence, live administrator removal, scope restrictions, pagination, and restart.
