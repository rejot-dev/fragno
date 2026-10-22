---
name: backoffice-first-party-app
description:
  First-party Backoffice apps. Use when creating an app backed by Backoffice accounts, registering
  its OAuth client and branding, calling Backoffice APIs, provisioning tenants, enforcing shared
  membership, or exposing app actions to Backoffice agents. Bookkeeping is the reference
  integration.
---

# Build a first-party Backoffice app

Build a separate product on Backoffice's identity and authority, not a second identity system that
synchronizes with it. People sign in under the product's branding; they need not know Backoffice
exists. First-party trust removes consent friction, not tenant isolation or permission checks.

Repository paths below are relative to the repository root (`../../..` from this skill). Read the
linked implementation before adapting a flow: code is authoritative, and the v0 contract can break.
Bookkeeping demonstrates the integration, not a required accounting domain or hosting architecture.

## 1. Assign ownership

Read [Bookkeeping's overview](../../../apps/bookkeeping/README.md) and the
[public API contract](../../../packages/backoffice-api/README.md). Map each required feature to its
owner:

| Concern                                                           | Authority                                                   | What the new app keeps                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Identity, email verification, OAuth authorization                 | Backoffice Auth                                             | Local session and provider-account record keyed by Backoffice's user subject |
| Organizations, memberships, owner/admin/member roles, invitations | Backoffice                                                  | A read-only projection, with an explicit access-confirmation lifetime        |
| App registration, first-party trust, installations and grants     | Backoffice                                                  | Its client configuration and references returned by Backoffice               |
| Product data and onboarding progress                              | The app                                                     | Its domain records and durable progress                                      |
| Project-backed domain objects, when needed                        | Backoffice owns the project; the app owns the domain object | The returned project ID and the app's own object data                        |

Choose the tenancy the product actually needs. Bookkeeping's tenants are organizations only: firms,
and the clients each firm creates. Backoffice also supports personal installations and private app
scopes. An app's UI “workspace” is not necessarily Backoffice's `kind: "app"` scope.

Use Backoffice IDs for authority and persistence references. Keep local session-user IDs distinct
from Backoffice user IDs; a matching email or organization slug is not an identity binding. Use
returned slugs for navigation where appropriate, not as API IDs.

**Complete when:** every identity, tenant, role, and domain record has one authority; every local
copy has a refresh policy; and every required API call has a named actor and target scope.

## 2. Register and establish sign-in

Follow [registration and identity](references/registration-and-identity.md), including an app-local
`backoffice:connect` script that creates or repairs its dedicated OAuth client and first-party
registration. Implement Backoffice-only sign-in and a local server-side session; let Backoffice own
email codes and account creation. Registration, OAuth authorization, and tenant installation are
separate boundaries.

Keep the login copy product-facing. Ask for product-specific information after sign-in, including a
name if userinfo has none. Reuse the private design system for generic UI rather than copying
Backoffice pages into the app.

**Complete when:** a new address and an existing Backoffice user both return to the app signed in,
with the correct Backoffice subject, no consent review, and no provider credentials exposed to the
browser. Running `backoffice:connect` twice preserves the client and app identities and converges on
the declared configuration.

## 3. Call APIs with the right authority

Read [Bookkeeping's server client](../../../apps/bookkeeping/workers/backoffice/client.ts) and
[execution credentials](../../../apps/backoffice/app/fragno/auth/README.md). Keep the credential
paths distinct:

| Work                                      | Starting credential                         | Next boundary                                                         |
| ----------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| Create tenants or send/accept invitations | App OAuth `client_credentials` token        | Directly call `createBackofficeProvisioningClient`                    |
| Read or mutate as the signed-in person    | That person's Backoffice OAuth access token | Exchange for an explicit scope, then use `createBackofficeApiClient`  |
| Background work as an installation        | App OAuth `client_credentials` token        | Exchange for an installed scope, then use `createBackofficeApiClient` |

Import both clients from `@fragno-dev/backoffice-api/v0/client`. Their operation schemas and types
live in the versioned family modules; import those definitions instead of inventing response types
or calling Backoffice's private fragment routes. Supply the server's `fetch` at the transport edge.

The exchange is `POST /api/backoffice/execution-token`, with an OAuth bearer and
`{ scope: { kind: "org", orgId } }` (or another supported explicit scope). Its returned
`accessToken` authenticates versioned scoped calls. An OAuth token is not an execution credential; a
browser session cookie is not either API's bearer credential.

For user-initiated management, act as the user: effective authority is the user's live permissions
intersected with installation grants. An installation token carries no user; substituting it after a
user's refusal would bypass that boundary. Apps never hold `account.manage`, `apps.read`,
`apps.manage`, or `org.manage`, and registering an app that requests one fails: invite through
provisioning `invitations.create`, never scoped `org.invitations.create`. First-party apps still use
`installed-app` execution policy. `first-party-user` is reserved for Backoffice's deployment
Codemode client, not this app.

### Scope and failure handling

- Construct scopes with `@fragno-dev/backoffice-api/v0/shared/scope`. The typed client serializes
  them. An organization scope does not grant access to its installed apps' private scopes.
- Request only the operation permissions the product uses. OAuth scopes, requested API permissions,
  and first-party provisioning permissions are three different declarations.
- Distinguish reauthorization, forbidden access, outages, and programming/configuration failures. At
  exchange, 401 rejects authentication; renew a user's expired/revoked grant, but surface an
  ineligible or misconfigured client rather than looping through login. A 403 refuses the requested
  tenant/scope. Network failure or a server outage is not evidence that membership was revoked.
- `BackofficeApiUnreachableError` and `BackofficeApiRequestError` with `code === null` mean the
  outcome is unknown. Retry mutations only when their operation is idempotent. Handle known API
  codes explicitly; let malformed successful responses and unexpected errors surface as bugs.

**Complete when:** every call uses the correct credential and scope, user actions retain user
restrictions, and refusal, reauthorization, and unknown outcomes take distinct paths.

## 4. Integrate only the product's required flows

- **Tenants, membership, onboarding, projects, invitations:** read
  [tenant flows](references/tenant-flows.md). Begin with pull-based access confirmation, not a
  webhook synchronization system. Backoffice stays authoritative.
- **Agents calling the app or app-triggered automations:** read
  [actions and events](references/actions-and-events.md). An action endpoint and an outgoing event
  are different directions of integration; neither is a prerequisite for sign-in.
- **Durable onboarding:** also read [Fragno Workflows](../fragno-workflows/SKILL.md) before
  implementing replayable steps. Bootstrap belongs in the app: the Backoffice tenant it would run in
  may not exist yet.

**Complete when:** each selected flow has an authorization boundary, stable retry identity where
needed, and an observable result. Leave unrequested flows unimplemented.

## 5. Prove the boundaries through scenarios

Use [Bookkeeping's harness](../../../apps/bookkeeping/scenario/bookkeeping-scenario.ts) as the
app-side reference: real routes, cookies, SQLite-backed state, and production Durable Object code
behind an in-process runtime. Its
[fake Backoffice](../../../apps/bookkeeping/scenario/fake-backoffice.ts) checks the public schemas,
but does not prove the real provider or kernel. For changes to Backoffice itself, extend its
[first-party scenarios](../../../apps/backoffice/app/backoffice-api/first-party-app.scenario.test.ts)
and
[installed-app scenarios](../../../apps/backoffice/app/backoffice-api/installed-app.scenario.test.ts).

Cover each implemented boundary with a user flow and final-state assertions:

- Sign-in and protected navigation; return destinations survive login; tokens stay server-only.
- Tenant isolation, role changes, member removal, and uninstall after access-cache expiry; an outage
  denies unconfirmed access without erasing domain data.
- Provisioning retries after partial success produce one tenant/domain object; durable onboarding
  resumes with its saved answers, including duplicate submissions after completion.
- Invitations work for the invited verified address, not another user; ordinary members cannot
  invoke manager-only product actions.
- Declared actions accept signed calls only for the intended tenant and reject tampered bodies or
  expired/wrong-audience tokens.

Run the repository checks from `AGENTS.md`. For a new Worker app, verify lint from a clean generated
state: [Bookkeeping's task configuration](../../../apps/bookkeeping/turbo.json) makes lint depend on
type generation. Stale local generated files can conceal CI failures.

**Complete when:** applicable scenarios and checks pass, and a real browser smoke test covers the
branded sign-in round trip and first tenant. Report any unrun checks or unavailable credentials; a
schema-valid fake alone is not end-to-end OAuth verification.
