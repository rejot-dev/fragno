# Bookkeeping

Minimal React Router framework app deployed to Cloudflare Workers. Better Auth handles
email/password authentication in one SQLite Durable Object named `auth`. No D1 database or external
auth service is required. UI components, theme tokens, and the self-hosted brand font come from
`@fragno-private/design-system`, shared with Backoffice. Tailwind processes the shared package's
styles; Bookkeeping's own stylesheet only handles its page layout.

## Local development

From the repository root:

```sh
pnpm install
cd apps/bookkeeping
cp .dev.vars.example .dev.vars
```

Replace `BETTER_AUTH_SECRET` in `.dev.vars` with a random secret (generate one with
`openssl rand -base64 32`). Keep `BOOKKEEPING_BASE_URL` aligned with the app's origin; Bookkeeping
runs at `http://127.0.0.1:6174` so Backoffice can run on port 5173. Configure the Backoffice OAuth
credentials as described below.

```sh
pnpm dev
```

Routes: `/` (public frontpage), `/signup`, `/login`, `/dashboard` (workspace overview),
`/dashboard/organizations` (create and switch organizations), `/dashboard/backoffice` (organization
connection and test events), `/dashboard/backoffice/callback` (return from Backoffice installation),
`/dashboard/account` (profile and logout), and Better Auth's `/api/auth/*` endpoints. The public
layout includes a header and footer; the workspace uses a collapsible desktop sidebar and mobile
navigation. Dashboard routes require a valid server-side session and redirect anonymous requests to
login. Login and signup send successful sign-ins to the dashboard. Signed-in visitors are redirected
away from auth pages. Personalized route responses are marked private and non-cacheable.

Authentication forms require JavaScript. The dashboard is an honest empty workspace; transaction,
accounting, and reporting functionality, email verification, and password reset delivery are not
implemented.

## Backoffice login

The login and signup pages offer **Continue with Backoffice**. New Backoffice users get a local
Bookkeeping account on their first successful login. The same authorization also lets Bookkeeping's
server act for that user in Backoffice organizations that have installed Bookkeeping (see
[Organizations and Backoffice](#organizations-and-backoffice)).

Set these values in `.dev.vars` (never commit credentials):

- `BACKOFFICE_BASE_URL`: the exact Backoffice origin used in your browser, e.g.
  `http://127.0.0.1:5173`. Do not mix `localhost` and `127.0.0.1`.
- `BACKOFFICE_OAUTH_CLIENT_ID`: a dedicated client ID returned by Backoffice.
- `BACKOFFICE_OAUTH_CLIENT_SECRET`: the initial secret returned when creating that confidential
  client.
- `BOOKKEEPING_BASE_URL`: the Bookkeeping origin, e.g. `http://127.0.0.1:6174`.

Create a dedicated confidential client in the **Backoffice terminal**, in System context, as a
global administrator (not in your host shell):

```sh
admin.oauth-clients.create --name Bookkeeping --application-type native --client-type confidential --redirect-uri http://127.0.0.1:6174/api/auth/callback/backoffice --scope openid --scope profile --scope email --scope offline_access --scope backoffice --client-credentials
```

The native application type allows the local HTTP loopback callback. For production, create a
separate confidential `web` client with an HTTPS redirect URI:
`https://YOUR_BOOKKEEPING_HOST/api/auth/callback/backoffice`.

Keep the returned ID and secret securely; creation is not idempotent. Login alone needs no app
registration or organization installation. Do not reuse the deployment Codemode client. After
updating `.dev.vars`, restart Bookkeeping and approve the requested scopes in Backoffice.

`--client-credentials` lets Bookkeeping's server act as its installation in a connected
organization. To upgrade an existing identity-only client in place, its owning administrator runs
`admin.oauth-clients.update --client-id CLIENT_ID` with the redirect URI, the scopes above, and
`--client-credentials`. Existing users sign in with Backoffice again to grant the new scopes;
consents are never silently widened. `admin.oauth-clients.rotate-secret --client-id CLIENT_ID`
replaces a leaked secret.

The provider uses explicit `/api/auth/oauth2/authorize`, `/api/auth/oauth2/token`, and
`/api/auth/oauth2/userinfo` endpoints because Backoffice does not mount root OIDC discovery. PKCE
uses S256 and the confidential client authenticates using `client_secret_basic`. Every
authorization, token, and refresh request names Backoffice as the OAuth `resource`, which Backoffice
requires before it exchanges a token for execution credentials. Identity comes from authenticated
userinfo, not unverified ID-token decoding. Logging out clears the Bookkeeping session; it does not
log you out of Backoffice.

Provider tokens are encrypted at rest. Better Auth's `/api/auth/get-access-token` and
`/api/auth/refresh-token` HTTP endpoints are disabled, so browsers never receive Backoffice tokens;
only Bookkeeping's server reads them through the Auth Durable Object.

## Organizations and Backoffice

Bookkeeping uses Better Auth's organization plugin. Create an organization at
`/dashboard/organizations`; you become its owner and it becomes your active organization.

An organization connects to one Backoffice organization (and vice versa). One-time setup in the
**Backoffice terminal**, in System context, as a global administrator:

```sh
admin.apps.create --oauth-client-id BOOKKEEPING_CLIENT_ID --requested-permissions-json '[{"namespace":"events","permission":"emit"}]'
```

Then an owner or admin of the Bookkeeping organization opens **Backoffice → Connect to Backoffice**:

1. Bookkeeping records a single-use, 10-minute state bound to that user and organization, and
   redirects to Backoffice's install page.
2. In Backoffice, an owner or admin of a Backoffice organization chooses the organization, the
   permissions to approve, and either the whole organization or selected projects.
3. Backoffice returns to `/dashboard/backoffice/callback` with a short-lived code. Bookkeeping
   consumes the state, authenticates with client credentials, and claims the installation for its
   organization at `POST /api/backoffice/app-installations/claim`. The Backoffice installation
   records the Bookkeeping organization; Bookkeeping records the Backoffice organization and the
   approved access.

To link a different Bookkeeping organization, uninstall Bookkeeping in Backoffice first.
**Disconnect** only forgets the link in Bookkeeping; revoking access is Backoffice's decision.

### Sending events

Any member of a connected organization can send one `bookkeeping.connection.tested` event to an
approved target (the organization, or one of the approved projects):

- **Send as the organization** uses a client-credentials token, so it needs no Backoffice account.
  Backoffice attributes the event to the Bookkeeping organization and limits it to the
  installation's approved permissions and resources.
- **Send as you** uses your own linked Backoffice account. Backoffice additionally requires that you
  are currently a member there and may emit events yourself.

Either way, Bookkeeping's server exchanges its OAuth token at `POST /api/backoffice/execution-token`
for a 15-minute credential bound to that target, then calls the `events.fire` operation of the
Backoffice API with the typed client from `@fragno-dev/backoffice-api/v0/client`. The page shows the
accepted event ID, which organization members can inspect in Backoffice with
`events.get --id EVENT_ID`. If Backoffice rejects your own token (for example after revoking
Bookkeeping, or for a sign-in made before the `backoffice` scope was configured), the page asks you
to reauthorize. A delivery that cannot be confirmed is reported, not retried, to avoid duplicates.

Uninstalling Bookkeeping, narrowing its permissions or projects, or removing a member in Backoffice
takes effect immediately, including for credentials already issued.

## Checks

```sh
pnpm types:check
pnpm build
```

## Deployment

From `apps/bookkeeping`, set the production URL and a separate production secret:

```sh
pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put BOOKKEEPING_BASE_URL
pnpm exec wrangler secret put BACKOFFICE_BASE_URL
pnpm exec wrangler secret put BACKOFFICE_OAUTH_CLIENT_ID
pnpm exec wrangler secret put BACKOFFICE_OAUTH_CLIENT_SECRET
pnpm deploy
```

Set `BOOKKEEPING_BASE_URL` to the final HTTPS origin (your Workers URL or custom domain). Do not use
the example secret in production. The first deployment creates the SQLite Durable Object namespace.

## Schema

The Durable Object applies versioned SQL migrations in order before serving requests; each one
commits atomically with its version. It uses Fragno's Kysely Durable Object dialect, which does not
support Better Auth migration introspection, so schema changes are new migration files rather than
edits to existing ones.

- `workers/auth-schema.sql`: Better Auth 1.7.1's default schema for email/password and accounts.
- `workers/auth-schema-0002-organizations.sql`: the organization plugin's tables (without teams or
  dynamic roles), plus Backoffice link requests and links.
