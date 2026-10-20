# Bookkeeping

Minimal React Router framework app deployed to Cloudflare Workers. Better Auth keeps sessions and
accounts in one SQLite Durable Object named `auth`; people sign up and sign in with their Backoffice
account only. No D1 database or external auth service is required. UI components, theme tokens, and
the self-hosted brand font come from `@fragno-private/design-system`, shared with Backoffice.
Tailwind processes the shared package's styles; Bookkeeping's own stylesheet only handles its page
layout.

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

Routes: `/` (public frontpage), `/login` (get started), `/help` (help signing in), `/signup`
(redirects to `/login`), `/dashboard` (workspace overview), `/dashboard/organizations` (create and
switch organizations), `/dashboard/backoffice` (organization connection and test events),
`/dashboard/backoffice/callback` (return from Backoffice installation), `/dashboard/account`
(profile and logout), and Better Auth's `/api/auth/*` endpoints. The public layout includes a header
and footer; the workspace uses a collapsible desktop sidebar and mobile navigation. Dashboard routes
require a valid server-side session and redirect anonymous requests to login. Signing in sends
people to the dashboard. Signed-in visitors are redirected away from auth pages. Personalized route
responses are marked private and non-cacheable.

Signing in requires JavaScript. The dashboard is an honest empty workspace; transaction, accounting,
and reporting functionality are not implemented.

## Backoffice login

Bookkeeping has no passwords and never names Backoffice to people signing in: its users need not
know it exists. **Get started** sends them to Backoffice's sign-in, which Bookkeeping's
[first-party branding](../backoffice/app/fragno/apps/README.md#first-party-apps) makes look like
Bookkeeping. They enter their email and the 6-digit code Backoffice emails them in Bookkeeping's
name; a new address gets an account. They then return here signed in, and get a local Bookkeeping
account on their first sign-in. `backoffice:connect` registers the branding, with `/logo.svg` and
`/help` from `public/` and `app/routes/help.tsx`. The same authorization also lets Bookkeeping's
server act for that user wherever Bookkeeping is installed in Backoffice (see
[Organizations and Backoffice](#organizations-and-backoffice)).

`pnpm --dir apps/bookkeeping backoffice:connect` sets all of these up (see
[Organizations and Backoffice](#organizations-and-backoffice)). To configure them by hand, set these
values in `.dev.vars` (never commit credentials):

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

An organization connects to one Backoffice owner (and vice versa): a Backoffice organization, or a
Backoffice user who installed Bookkeeping for themselves. One-time setup, as a Backoffice global
administrator, from the repository root:

```sh
pnpm --dir apps/bookkeeping backoffice:connect
```

The script signs in through the Backoffice CLI, creates Bookkeeping's OAuth client (or repairs the
one in `.dev.vars`: callback URL, scopes, and client credentials), registers the app with
`events.emit` and the actions declared in `workers/backoffice-actions.ts`, and writes the client ID,
secret, and both origins to `.dev.vars`. Bookkeeping is registered as a first-party app with every
provisioning permission: Backoffice skips its consent screen and permission review, and Bookkeeping
may create organizations and administrations in Backoffice and accept invitations for its users (see
Backoffice's `app/fragno/apps/README.md`). It reads both origins from `.dev.vars` and defaults to
`http://127.0.0.1:5173` and `http://127.0.0.1:6174`; pass `--backoffice-url` or `--bookkeeping-url`
to change them, which also moves the callback and the action endpoint. The app is registered as
`app#bookkeeping`; pass `--slug` to choose another permanent name. Rerunning converges on the same
client and app, updating its requested permissions and actions in place. Action changes apply
automatically to existing installations; pass `--change-approval installation` to make each
installation's owner approve them. Production requires HTTPS.

Then an owner or admin of the Bookkeeping organization opens **Backoffice → Connect to Backoffice**:

1. Bookkeeping records a single-use, 10-minute state bound to that user and organization, and
   redirects to Backoffice's install page.
2. In Backoffice, the user chooses where to install: an organization they own or administer, or
   themselves. Bookkeeping is first-party, so there is no permission review: it gets every
   permission it requests, over everything the owner has.
3. Backoffice returns to `/dashboard/backoffice/callback` with a short-lived code. Bookkeeping
   consumes the state, authenticates with client credentials, and claims the installation for its
   organization at `POST /api/backoffice/app-installations/claim`. The Backoffice installation
   records the Bookkeeping organization; Bookkeeping records the Backoffice owner and the approved
   access.

To link a different Bookkeeping organization, uninstall Bookkeeping in Backoffice first.
**Disconnect** only forgets the link in Bookkeeping; revoking access is Backoffice's decision.

### Sending events

Any member of a connected organization can send one `bookkeeping.connection.tested` event to an
approved target (the owner, or one of the approved projects):

- **Send as the organization** uses a client-credentials token, so it needs no Backoffice account.
  Backoffice attributes the event to the Bookkeeping organization and limits it to the
  installation's approved permissions and resources.
- **Send as you** uses the Backoffice account you signed in with. Backoffice additionally requires
  that you are currently a member there and may emit events yourself; where a user installed
  Bookkeeping for themselves, only that user can.

Either way, Bookkeeping's server exchanges its OAuth token at `POST /api/backoffice/execution-token`
for a 15-minute credential bound to that target, then calls the `events.fire` operation of the
Backoffice API with the typed client from `@fragno-dev/backoffice-api/v0/client`. The page shows the
accepted event ID, which organization members can inspect in Backoffice with
`events.get --id EVENT_ID`. If Backoffice rejects your own token (for example after revoking
Bookkeeping, or for a sign-in made before the `backoffice` scope was configured), the page asks you
to reauthorize. A delivery that cannot be confirmed is reported, not retried, to avoid duplicates.

Uninstalling Bookkeeping, narrowing its permissions or projects, or removing a member in Backoffice
takes effect immediately, including for credentials already issued.

### Backoffice actions

Backoffice calls Bookkeeping too: a connected organization's members and agents run
`organization.get` through the `app#bookkeeping` integration connection, e.g.
`integrations.execute --connection-id 'app#bookkeeping' --action-id organization.get --input-json '{}'`,
or through a client from `integrations.generateClient`. `workers/backoffice-actions.ts` serves
`POST /api/backoffice/actions`: it verifies Backoffice's per-request token with
`createAppActionVerifier`, then answers only for the Bookkeeping organization the installation
claimed, and only while that organization is still linked to the Backoffice organization the request
names.

## Bookkeeping schema

The SQLite schema for an administration's books lives in `workers/schema`; see its README. No route
or Durable Object uses it yet.

## Checks

```sh
pnpm types:check
pnpm test
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

- `workers/auth-schema.sql`: Better Auth 1.7.1's default schema for users, sessions, and accounts.
- `workers/auth-schema-0002-organizations.sql`: the organization plugin's tables (without teams or
  dynamic roles), plus Backoffice link requests and links.
