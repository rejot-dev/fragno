# Registration and identity

## Read before adapting

- [Setup script](../../../../apps/bookkeeping/scripts/connect-backoffice.ts): administrator login,
  client repair, registration updates, credential persistence.
- [Auth implementation](../../../../apps/bookkeeping/workers/auth/auth.ts): provider configuration,
  subject mapping, encrypted tokens, refresh state machine.
- [Session boundary](../../../../apps/bookkeeping/app/auth/session.server.ts): server-only identity
  lookup and same-origin mutation checks.
- [App contract](../../../../packages/backoffice-api/src/v0/apps.ts) and
  [registration tools](../../../../apps/backoffice/app/fragno/apps/README.md): canonical declaration
  and current administration commands.

## Register once; repair explicitly

Run administration through the Backoffice CLI in **System scope as a global administrator**.
`admin.*` commands belong to Backoffice's runtime, not the host shell or the public v0 API. Creating
the setup script is separate from permission to run it against a deployment.

Provision a dedicated confidential client, using authorization code + S256 PKCE,
`client_secret_basic`, and the scopes `openid profile email offline_access backoffice`. Enable
client credentials for provisioning or installation-owned background work. Use `native` for HTTP
loopback development callbacks and `web` with HTTPS for production; these remain confidential
clients. Use separate development and production credentials.

Register that existing client as an app with:

- an immutable slug, addressed as `app#<slug>`;
- `requestedPermissions` derived from its scoped API operations;
- `trust: { kind: "first-party", provisioningPermissions, branding }`;
- branding fields `displayName`, `logoUrl`, `accentColor`, `homeUrl`, and `supportUrl`;
- `{ kind: "none" }` actions unless the product exposes an action endpoint.

First-party provisioning grants are per operation. Bookkeeping requests `org.read` and all five
current provisioning permissions because it implements those flows; a smaller app should request
less. Never request `account.manage`, `apps.read`, `apps.manage`, or `org.manage`: only people
acting directly hold them, and registration rejects them. First-party installations follow changed
requested permissions within the registry cache lifetime (currently one minute). Treat permission
updates as authority changes, not just metadata edits.

## Ship `backoffice:connect`

Give the new app `scripts/connect-backoffice.ts` and a `backoffice:connect` package script, adapting
Bookkeeping's setup script rather than requiring a sequence of manual admin commands. The host-shell
entry point is:

```sh
pnpm --dir apps/<app> backoffice:connect
```

The script owns convergence on the declaration above:

1. Read the app's local configuration and explicit origin overrides. Offer `--help`,
   `--backoffice-url`, an app-origin flag, and `--slug`; derive callback, branding, and action URLs
   from those origins. Import action declarations from the handler's canonical definition.
2. Build the Backoffice CLI, then use its `login` and `exec system` flow against the selected
   Backoffice origin. Parse structured command results and stop on a failed subprocess.
3. Find the stored OAuth client, following list cursors. Create it only when absent; otherwise
   repair its callback, scopes, and client-credentials setting. Preserve an existing secret;
   recovering a missing secret requires deliberate rotation by the client's owning administrator.
4. Find the app by OAuth client ID. Create it when absent; otherwise update permissions, trust
   (including branding), and actions with their explicit update commands. Read both records back and
   fail with actionable diagnostics if they do not match the intended declaration.
5. Write the origins, client ID, and secret to the app's ignored `.dev.vars`, preserving unrelated
   entries and valid existing secrets. For a Better Auth app, generate its session/encryption secret
   only when missing or still a placeholder. Keep secret-bearing results out of logs and use
   restrictive file permissions.
6. Print what was created or repaired and the next steps: restart the app, try sign-in, and, when
   actions are declared and a tenant is installed, run `integrations.verify` for `app#<slug>`.
   Report any action revision that requires installation approval.

OAuth client creation is not idempotent. Retain newly issued credentials even if a later setup step
fails, so a retry can repair the same registration. Do not create a replacement client to repair a
declaration: the old app still owns its permanent slug. A conflicting slug requires an explicit
operator decision, not silently selecting a different product identity.

Keep the Backoffice origin identical in the browser and server configuration: `localhost` and
`127.0.0.1` are different issuers and cookie origins. Keep production secrets in the deployment's
secret store; this local connection command is not a deployment or a tenant-provisioning command.

**Complete when:** first run creates usable configuration, a second run keeps the same client and
app IDs without rotating valid secrets, and rerunning after a callback or declaration change repairs
those records in place. Verify the instructions from a fresh checkout, not only existing local
state.

## Let Backoffice own sign-up

Use the provider configuration in Bookkeeping's Auth implementation, not a second password or email
verification flow. Its explicit endpoints are under the Backoffice origin:

- `/api/auth/oauth2/authorize`
- `/api/auth/oauth2/token`
- `/api/auth/oauth2/userinfo`

Backoffice does not mount root OIDC discovery. Send `resource=<Backoffice origin>` on authorization,
token, and refresh requests. Establish identity from authenticated userinfo; do not decode an
unverified ID token as proof of identity. Let the OAuth library own state and PKCE verification.

A signed authorization request for a registered first-party client selects Backoffice's product-
branded email-code sign-in. A new address becomes a verified Backoffice account, even when
Backoffice's own sign-up is invitation-only. OAuth continues back to the app, which establishes its
local session. Product copy can say “Get started”; users need not link a second account or know
Backoffice's name.

Backoffice automatically records real OAuth consent through its consent endpoint. First-party
consents are hidden from personal authorization listings and cannot be revoked there. Preserve this
provider flow instead of setting `skip_consent`: userinfo and execution still require that record.

Branded sign-in requires a valid provider-signed request, not a free `appId` or branding query
parameter. Leave code delivery and verification in Backoffice. Local loopback Backoffice prints
codes for development; production needs its email delivery configured. A logo and support URL are
real public app resources, not placeholder deployment URLs.

## Keep provider tokens on the server

A local auth library may keep session users and provider-account rows. Its local user ID is not the
Backoffice user ID: Bookkeeping obtains `backofficeUserId` from the provider account's `accountId`.
Use that subject for provisioning and membership operations; derive it from the session, not form
input. A user without the required provider account violates this app's sign-in invariant.

When using Better Auth as Bookkeeping does:

- Disable local password sign-in and enable OAuth token encryption at rest.
- Disable browser-facing `/get-access-token` and `/refresh-token` endpoints. Server-only methods
  obtain and refresh the provider tokens.
- Coalesce concurrent refreshes per provider account: refresh tokens may rotate. Persist the new
  access token and any replacement refresh token encrypted.
- Model authorized, reauthorization-required, and Backoffice-unavailable separately. A revoked grant
  requires sign-in; network/5xx failure preserves the grant and reports an outage. Rejected client
  configuration and malformed responses are operational bugs, not logout signals.

Validate return destinations as app-local, preserve invitation destinations through login, and check
the app's exact origin for cookie-authenticated mutations. Mark personalized responses private and
non-cacheable. Local logout clears the app's session, not Backoffice's session.
