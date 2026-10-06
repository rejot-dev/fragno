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
app registration, and listing. Ordinary developer management, installation tokens, and runtime
execution authorization remain outside this scaffold. Marketplace packages remain independent.

## System admin OAuth client tools

`admin.oauthClientsCreate` / `admin.oauth-clients.create` requires `admin.oauth-clients.manage`,
System context, and an administrator user principal. The OAuth client belongs to that Auth user;
callers cannot choose or forge its owner. Metadata, redirects, and credentials stay exclusively in
Auth.

```ts
const client = await admin.oauthClientsCreate({
  name: "Accounting",
  redirectUris: ["https://accounting.example/callback"],
  scopes: ["openid", "profile", "email", "offline_access"],
  clientType: "confidential",
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
  --scope openid --scope profile --scope email --scope offline_access --format json
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
requested. Supported OAuth scopes are defined by `BACKOFFICE_OAUTH_SCOPES` in
`auth/oauth-client.ts`; they are not app capability declarations or organization installation
grants. The shared Backoffice execution token exchange still accepts only the deployment's Codemode
client under an explicit first-party user policy. Registering or installing an app does not grant
that policy. See [`../auth/README.md`](../auth/README.md) for the shared execution flow and its
entry point.

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

## Review and revoke personal OAuth authorizations

Open **Account menu → Authorized applications**, or **Settings → Authorized applications** at
`/backoffice/settings/authorized-applications`. This page requires a live browser session and shows
only that user's grants, including new Codemode device approvals, with client names, IDs, scopes,
and approval timestamps. It is not an organization installation-management page.

**Revoke access** deletes that user's consent, stored access tokens, refresh tokens, and pending or
approved device codes for the selected client. Live consent is checked when minting user OAuth
claims, serving userinfo, and exchanging a first-party OAuth token for Backoffice execution. This
prevents an already-issued OAuth JWT from obtaining fresh execution credentials after revocation.
Previously issued self-contained tokens may still be usable by external verifiers until expiry;
already-issued Backoffice execution JWTs retain their existing maximum 15-minute lifetime.

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

Listing defaults to 25 registrations, allows 1–100 per page, and returns `apps`, `nextCursor`, and
`hasNextPage`. Resume using the same page size. Output contains only registry data, never OAuth
credentials or organization installation grants.

## Commands and transaction boundaries

```ts
const registry = runtime.objects.apps.singleton().commands;
const installations = runtime.objects.appInstallations.forOrg(organizationId).commands;
```

| Object       | Command                                                | Registry access                                           |
| ------------ | ------------------------------------------------------ | --------------------------------------------------------- |
| Registry     | `registerApp`, `getApp`, `listApps`                    | Own local database                                        |
| Organization | `installApp`                                           | Resolve declaration before local installation transaction |
| Organization | `updateInstallationGrants`                             | Resolve declaration before local grant transaction        |
| Organization | `getInstallation`, `listInstallations`, `uninstallApp` | None                                                      |

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
- Uninstall clears grants but retains identity. Reinstall reuses that identity and records the newly
  approved grants and installer.
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
