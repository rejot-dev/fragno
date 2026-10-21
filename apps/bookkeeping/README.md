# Bookkeeping

Minimal React Router framework app deployed to Cloudflare Workers, built on Backoffice: people sign
in with Backoffice accounts, each workspace is a Backoffice organization, and each administration in
it, the books of one business, is a Backoffice project. SQLite Durable Objects hold Bookkeeping's
state; no D1 database or external auth service is required:

- `Auth` (`auth`): Better Auth's users, sessions, and Backoffice accounts.
- `Workspaces` (`workspaces`): each workspace's administrations, and the read-only copy of
  Bookkeeping's Backoffice organizations, their members, and the invitations Bookkeeping created.
- `Workflows` (`workflows`): the Fragno workflows fragment, which runs the sign-up wizard.
- `Books` (one per administration, named by its Backoffice project's ID): the administration's
  books.

UI components, theme tokens, and the self-hosted brand font come from
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

Routes: `/` (public frontpage), `/login` (get started), `/help` (help signing in), `/signup`
(redirects to `/login`), `/start` (where signing in lands), `/welcome` (the sign-up wizard),
`/invitations/:invitationId` (join a workspace), `/w/:slug` (workspace overview and its
administrations), `/w/:slug/administrations/new` (create one), `/w/:slug/a/:administration` (an
administration's books), `/w/:slug/members` (members and invitations), `/w/:slug/account` (profile
and logout), and Better Auth's `/api/auth/*` endpoints. The workspace uses a collapsible desktop
sidebar, mobile navigation, and a workspace switcher. Workspace routes require a session and the
person's membership; others redirect to login. Signed-in visitors are redirected away from auth
pages. Personalized route responses are marked private and non-cacheable.

Signing in requires JavaScript. An administration's books open empty; transaction, accounting, and
reporting functionality are not implemented.

## Backoffice login

Bookkeeping has no passwords and never names Backoffice to people signing in: its users need not
know it exists. **Get started** sends them to Backoffice's sign-in, which Bookkeeping's
[first-party branding](../backoffice/app/fragno/apps/README.md#first-party-apps) makes look like
Bookkeeping. They enter their email and the 6-digit code Backoffice emails them in Bookkeeping's
name; a new address gets an account. They then return here signed in, and get a local Bookkeeping
account on their first sign-in. `backoffice:connect` registers the branding, with `/logo.svg` and
`/help` from `public/` and `app/public/help.tsx`. The same authorization also lets Bookkeeping's
server act for that person in their workspaces (see [Workspaces](#workspaces)).

`pnpm --dir apps/bookkeeping backoffice:connect` sets all of these up (see
[Registering with Backoffice](#registering-with-backoffice)). To configure them by hand, set these
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

## Registering with Backoffice

One-time setup, as a Backoffice global administrator, from the repository root:

```sh
pnpm --dir apps/bookkeeping backoffice:connect
```

The script signs in through the Backoffice CLI, creates Bookkeeping's OAuth client (or repairs the
one in `.dev.vars`: callback URL, scopes, and client credentials), registers the app with `org.read`
and `org.manage` and the actions declared in `workers/backoffice/actions.ts`, and writes the client
ID, secret, and both origins to `.dev.vars`. Bookkeeping is registered as a first-party app with
every provisioning permission: Backoffice skips its consent screen and permission review, and
Bookkeeping may create organizations and administrations in Backoffice, and create, send, and accept
invitations for its users (see Backoffice's `app/fragno/apps/README.md`). It reads both origins from
`.dev.vars` and defaults to `http://127.0.0.1:5173` and `http://127.0.0.1:6174`; pass
`--backoffice-url` or `--bookkeeping-url` to change them, which also moves the callback and the
action endpoint. The app is registered as `app#bookkeeping`; pass `--slug` to choose another
permanent name. Rerunning converges on the same client and app, updating its requested permissions
and actions in place; as a first-party app, Bookkeeping has new permissions in every workspace
within a minute. Action changes apply automatically to existing installations; pass
`--change-approval installation` to make each installation's owner approve them. Production requires
HTTPS.

## Workspaces

A workspace is a Backoffice organization with Bookkeeping installed. Backoffice owns it, its
members, and their roles (owner, admin, member); Bookkeeping keeps a read-only copy in the
`Workspaces` object and never changes membership itself. Everyone in a workspace can open its books.

**Creating one.** Someone without a workspace lands in the sign-up wizard at `/welcome`, a
`create-workspace` workflow (`workers/workflows/create-workspace.ts`). It asks their name when
Backoffice has none, which is the case after an email-code sign-up, then their business's name. It
then creates the Backoffice organization with `organizations.provision`, which installs Bookkeeping
there for them as its owner, and records the workspace. Answers wait durably, so people can leave
and come back. Creating the organization retries while Backoffice is unreachable; if it still fails,
**Try again** retries that step with the answers given.

**Access.** Each workspace request checks the person's membership. A membership Backoffice confirmed
in the last minute is trusted; otherwise Bookkeeping exchanges the person's Backoffice token for a
credential in that organization (`POST /api/backoffice/execution-token`) and reads their roles with
`org.get`. When Backoffice refuses, because they were removed or Bookkeeping was uninstalled,
Bookkeeping forgets their membership and answers 404; nothing is deleted. While Backoffice is
unreachable, unconfirmed access answers 503. Members pages list members with `org.members.list` as
the viewer and refresh the copy, showing the names people gave Bookkeeping.

**Inviting.** Owners and admins invite on the members page: Bookkeeping creates the invitation with
`invitations.create` as the inviter, so Backoffice applies their current role (only owners invite
owners). Apps cannot use `org.invitations.create`, which only people acting directly may. Backoffice
then emails the invitation in Bookkeeping's name with `invitations.send`, linking to
`/invitations/:invitationId`; the page shows the link too, to send by hand when Backoffice cannot
email, as a local Backoffice without Resend cannot. The invited person signs in there and joins:
Bookkeeping calls `invitations.accept`, and Backoffice checks that the invitation is for their
verified address. Invitations are sent only from Bookkeeping; someone invited in Backoffice itself
finds the workspace once they open it.

### Backoffice actions

Backoffice calls Bookkeeping too: a workspace's members and agents run `organization.get` through
the `app#bookkeeping` integration connection, e.g.
`integrations.execute --connection-id 'app#bookkeeping' --action-id organization.get --input-json '{}'`,
or through a client from `integrations.generateClient`. `workers/backoffice/actions.ts` serves
`POST /api/backoffice/actions`: it verifies Backoffice's per-request token with
`createAppActionVerifier`, then describes the workspace of the organization the request was signed
for.

## Administrations

An administration is the books of one business. A workspace can have several, e.g. for a holding and
its subsidiaries; everyone in the workspace opens them, and owners and admins create them at
`/w/:slug/administrations/new` with a name and the currency the books are kept in. Creating one:

1. creates its Backoffice project with `projects.provision`, as the person creating it, so
   Backoffice agents can work on the administration in that project;
2. opens its books in a new `Books` object named by the project's ID (`workers/books`; see its
   README);
3. records it in the `Workspaces` object, which lists a workspace's administrations.

The form carries an identifier chosen when it was shown, and each step is idempotent, so submitting
it again after a failure, such as Backoffice being unreachable, finishes the steps left instead of
creating a second administration. Bookkeeping owns which projects are administrations: projects made
in Backoffice itself are not, and renaming or deleting a project there does not change the
administration.

## Layout

`app/` holds the React Router pages and `workers/` the Cloudflare Worker. Both are organized by
feature: a page sits with its server code and scenario tests, and each Durable Object has its own
folder with its migrations.

| Path                  | Holds                                                                |
| --------------------- | -------------------------------------------------------------------- |
| `app/auth`            | the session, the auth client, and the sign-in button every area uses |
| `app/public`          | signed-out pages: home, login, signup, help                          |
| `app/welcome`         | the sign-up wizard                                                   |
| `app/invitations`     | joining a workspace                                                  |
| `app/administrations` | creating and opening an administration                               |
| `app/workspace`       | `/start` and `/w/:slug`; `access.server.ts` checks membership        |
| `workers/worker.ts`   | the Worker's `fetch` entry, which exports the Durable Objects        |
| `workers/auth`        | the `Auth` object                                                    |
| `workers/workspaces`  | the `Workspaces` object                                              |
| `workers/workflows`   | the `Workflows` object and the `create-workspace` workflow           |
| `workers/backoffice`  | Backoffice's API client and the actions Backoffice calls             |
| `workers/books`       | the `Books` object and its schema                                    |
| `scenario/`           | the scenario test harness                                            |

## Checks

```sh
pnpm types:check
pnpm test
pnpm build
```

Scenario tests (`*.scenario.test.ts`) run Bookkeeping's pages, Durable Objects, and workflows in
Node with `scenario/bookkeeping-scenario.ts`:

- Durable Objects run their Cloudflare code unchanged on `FakeDurableObjectState`: `storage.sql` on
  in-memory SQLite, KV, transactions, alarms, and `blockConcurrencyWhile`. Calls cross a fake RPC
  boundary that copies arguments and results and keeps only errors' names and messages.
- `cloudflare:workers` resolves to `scenario/cloudflare-workers.ts`, whose `env` holds the running
  scenario's bindings.
- `FakeBackoffice` serves the Backoffice HTTP calls Bookkeeping makes, parsed with
  `@fragno-dev/backoffice-api`'s schemas; requests to any other origin fail.
- Browsers keep cookies and run Bookkeeping's routes through React Router's static handler, so
  layout loaders, actions, and redirects behave as in production.
- `drain()` fires due alarms, which run workflows and durable hooks; `advanceTime()` moves the
  clock.

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
the example secret in production. Deployments create the SQLite Durable Object namespaces.

## Schema

Each Durable Object applies versioned SQL migrations in order before serving requests; each one
commits atomically with its version. They use Fragno's Kysely Durable Object dialect, which does not
support Better Auth migration introspection, so schema changes are new migration files rather than
edits to existing ones. The workflows fragment migrates its own tables.

Each object's migrations are numbered files in its `migrations/` folder. An object records how many
it has applied, not their names.

- `workers/auth/migrations/0001-better-auth.sql`: Better Auth 1.7.1's default schema for users,
  sessions, and accounts.
- `0002-organizations.sql` and `0003-backoffice-owner.sql`: Bookkeeping's former organizations and
  their links to Backoffice, which `0004-drop-organizations.sql` drops.
- `workers/workspaces/migrations/0001-workspaces.sql`: the `Workspaces` object's copy, and
  `0002-administrations.sql` its administrations.
- `Books` applies `bookkeepingSchema` from `workers/books/schema.ts` as its first migration.
