---
name: backoffice-apps
description:
  Apps built on Backoffice, first- or third-party. Use when creating an app that signs people in
  with Backoffice, registering its OAuth client, installing or provisioning its tenants, calling
  Backoffice APIs, or exposing app actions to Backoffice agents. Bookkeeping is the reference
  integration.
---

# Build a Backoffice app

Build a separate product on Backoffice's identity and authority, not a second identity system that
synchronizes with it. Backoffice owns accounts, organizations, membership, and what each
installation may do; the app owns its product data. An app's **trust** decides how much of that
people review, never tenant isolation or permission checks.

Repository paths below are relative to the repository root (`../../..` from this skill). Read the
linked implementation before adapting a flow: code is authoritative, and the v0 contract can break.
Bookkeeping demonstrates the integration, not a required accounting domain or hosting architecture.

## 1. Choose the trust and assign ownership

Read [Bookkeeping's overview](../../../apps/bookkeeping/README.md), the
[public API contract](../../../packages/backoffice-api/README.md), and
[apps and installations](../../../apps/backoffice/app/fragno/apps/README.md). Choose the app's
trust, recorded in its registration as `trust.kind`:

|                     | First-party                                                    | Third-party (the default)                                |
| ------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| For                 | Products Backoffice's operators run, such as Bookkeeping       | Every other app                                          |
| Sign-in             | Branded as the app; any address signs up with an emailed code  | Backoffice's own sign-in, under its sign-up rules        |
| OAuth consent       | Recorded automatically; people cannot revoke it                | Each person reviews the request and can revoke it        |
| Tenants             | Provisioned by the app, or linked by an owner without review   | Linked by an owner who reviews permissions and resources |
| Installation grants | Follow the app's requested permissions within a minute         | Stay what the owner approved                             |
| Extra API           | Provisioning: organizations, projects, invitations, as the app | None                                                     |

Only a Backoffice system administrator registers an app or sets its trust; there is no developer
self-registration. Read the branch now: [first-party](first-party.md) or
[third-party](third-party.md). It adds to steps 2–5.

Map each required feature to its owner:

| Concern                                                           | Authority                                                   | What the app keeps                                                           |
| ----------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Identity, email verification, OAuth authorization                 | Backoffice Auth                                             | Local session and provider-account record keyed by Backoffice's user subject |
| Organizations, memberships, owner/admin/member roles, invitations | Backoffice                                                  | A read-only projection, with an explicit access-confirmation lifetime        |
| App registration, trust, installations and grants                 | Backoffice                                                  | Its client configuration and the installations it claimed                    |
| Product data and onboarding progress                              | The app                                                     | Its domain records and durable progress                                      |
| Project-backed domain objects, when needed                        | Backoffice owns the project; the app owns the domain object | The project ID and the app's own object data                                 |

Choose the tenancy the product actually needs from [tenancy](references/tenancy.md): organizations,
personal installations, selected projects, and the app's private workspace in each.

Use Backoffice IDs for authority and persistence references. Keep local session-user IDs distinct
from Backoffice user IDs; a matching email or organization slug is not an identity binding. Use
returned slugs for navigation where appropriate, not as API IDs.

**Complete when:** the trust is chosen; every identity, tenant, role, and domain record has one
authority; every local copy has a refresh policy; and every required API call has a named actor and
target scope.

## 2. Register and establish sign-in

Follow [registration and identity](references/registration-and-identity.md), including an app-local
`backoffice:connect` script that creates or repairs its dedicated OAuth client and registration,
with the branch's trust declaration. Implement Backoffice-only sign-in and a local server-side
session; let Backoffice own email verification and account creation. Registration, OAuth
authorization, and installation are separate boundaries.

Ask for product-specific information after sign-in, including a name if userinfo has none. Reuse the
private design system for generic UI rather than copying Backoffice pages into the app.

**Complete when:** a Backoffice user returns to the app signed in with the correct Backoffice
subject and no provider credentials in the browser, and the branch's sign-in criterion holds.
Running `backoffice:connect` twice preserves the client and app identities and converges on the
declared configuration.

## 3. Call APIs with the right authority

Read [Bookkeeping's server client](../../../apps/bookkeeping/workers/backoffice/client.ts) and
[execution credentials](../../../apps/backoffice/app/fragno/auth/README.md). Keep the credential
paths distinct:

| Work                                        | Starting credential                         | Next boundary                                                         |
| ------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| Read or mutate as the signed-in person      | That person's Backoffice OAuth access token | Exchange for an explicit scope, then use `createBackofficeApiClient`  |
| Background work as an installation          | App OAuth `client_credentials` token        | Exchange for an installed scope, then use `createBackofficeApiClient` |
| Claim an installation                       | App OAuth `client_credentials` token        | `POST /api/backoffice/app-installations/claim`                        |
| First-party only: provision tenants, invite | App OAuth `client_credentials` token        | Directly call `createBackofficeProvisioningClient`                    |

Import the clients from `@fragno-dev/backoffice-api/v0/client`. Their operation schemas and types
live in the versioned family modules; import those definitions instead of inventing response types
or calling Backoffice's private fragment routes. Supply the server's `fetch` at the transport edge.

The exchange is `POST /api/backoffice/execution-token`, with an OAuth bearer and
`{ scope: { kind: "org", orgId } }` (or another explicit scope inside the installation). Its
returned `accessToken` authenticates versioned scoped calls for 15 minutes. An OAuth token is not an
execution credential; a browser session cookie is not either API's bearer credential.

For user-initiated work, act as the user: effective authority is the user's live permissions
intersected with installation grants. An installation token carries no user; substituting it after a
user's refusal would bypass that boundary. Apps never hold `account.manage`, `apps.read`,
`apps.manage`, or `org.manage`, and registering an app that requests one fails, so no app manages
installations or membership through the scoped API. Every registered app uses the `installed-app`
execution policy; `first-party-user` is reserved for Backoffice's deployment Codemode client.

### Scope and failure handling

- Construct scopes with `@fragno-dev/backoffice-api/v0/shared/scope`. The typed client serializes
  them. An owner's scope does not reach its installed apps' private workspaces.
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

- **Tenants and access:** read [tenancy](references/tenancy.md) for linking an owner through the
  install page and confirming access by pulling authority, not a webhook synchronization system.
  First-party apps also create tenants, projects, and invitations through
  [provisioning](references/provisioning.md).
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
but does not prove the real provider or kernel. For changes to Backoffice itself, extend the
scenarios the branch names.

Cover each implemented boundary with a user flow and final-state assertions, plus the branch's
cases:

- Sign-in and protected navigation; return destinations survive login; tokens stay server-only.
- Tenant isolation, role changes, member removal, and uninstall after access-cache expiry; an outage
  denies unconfirmed access without erasing domain data.
- Ordinary members cannot invoke manager-only product actions.
- Declared actions accept signed calls only for the intended tenant and reject tampered bodies or
  expired/wrong-audience tokens.

Run the repository checks from `AGENTS.md`. For a new Worker app, verify lint from a clean generated
state: [Bookkeeping's task configuration](../../../apps/bookkeeping/turbo.json) makes lint depend on
type generation. Stale local generated files can conceal CI failures.

**Complete when:** applicable scenarios and checks pass, and a real browser smoke test covers the
sign-in round trip and first tenant. Report any unrun checks or unavailable credentials; a
schema-valid fake alone is not end-to-end OAuth verification.
