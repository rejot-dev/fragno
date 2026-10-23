# Bookkeeping

Minimal React Router framework app deployed to Cloudflare Workers, built on Backoffice: people sign
in with Backoffice accounts. Operators (we, running Bookkeeping) create accounting firms; a firm
creates its clients and keeps their books. Each firm and each client is a Backoffice organization,
and each administration in a client, the books of one business, is a Backoffice project. SQLite
Durable Objects hold Bookkeeping's state; no D1 database or external auth service is required:

- `Auth` (`auth`): Better Auth's users, sessions, and Backoffice accounts.
- `Directory` (`directory`): the read-only copy of Bookkeeping's Backoffice organizations, firms and
  clients, their members, and the invitations Bookkeeping created; and each client's
  administrations.
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
runs at `http://127.0.0.1:4173` so Backoffice can run on port 5173. Configure the Backoffice OAuth
credentials as described below.

```sh
pnpm dev
```

Routes:

| Path                                                         | What                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `/`                                                          | Public frontpage                                                         |
| `/login`, `/help`                                            | Signing in, and help with signing in; `/signup` redirects to `/login`    |
| `/name`                                                      | Asks a new person's name                                                 |
| `/start`                                                     | Where signing in lands: one place, or a choice of places and invitations |
| `/account`                                                   | Who is signed in, and logging out                                        |
| `/invitations/:invitationId`                                 | Joining a firm or a client                                               |
| `/operator`                                                  | Every firm, for operators only; `/operator/firms/new` creates one        |
| `/operator/members`                                          | The operators, and inviting more                                         |
| `/f/:slug`                                                   | A firm's clients; `/f/:slug/clients/new` creates one                     |
| `/f/:slug/members`                                           | The firm's members and invitations                                       |
| `/w/:slug`                                                   | A client's workspace: its administrations                                |
| `/w/:slug/administrations/new`, `/w/:slug/a/:administration` | Creating an administration, and its books                                |
| `/w/:slug/members`                                           | The client's members and invitations                                     |
| `/api/auth/*`                                                | Better Auth, served by the `Auth` object                                 |

The operator, firm, and client areas share a frame: a collapsible desktop sidebar, mobile
navigation, and a switcher between every place the person can go. Pages that require a session send
signed-out visitors to `/login?returnTo=<page>`, and people without a name to
`/name?returnTo=<page>`; both continue to that page, and only to Bookkeeping's own pages. Signed-in
visitors at `/login` continue to its `returnTo`. When Backoffice no longer accepts Bookkeeping's
authorization, the page sends them to `/login?reauthorize=1&returnTo=<page>` to sign in again.
Personalized route responses are marked private and non-cacheable.

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
server act for that person in their firms and clients (see [Firms and clients](#firms-and-clients)).

`pnpm --dir apps/bookkeeping backoffice:connect` sets all of these up (see
[Registering with Backoffice](#registering-with-backoffice)). To configure them by hand, set these
values in `.dev.vars` (never commit credentials):

- `BACKOFFICE_BASE_URL`: the exact Backoffice origin used in your browser, e.g.
  `http://127.0.0.1:5173`. Do not mix `localhost` and `127.0.0.1`.
- `BACKOFFICE_OAUTH_CLIENT_ID`: a dedicated client ID returned by Backoffice.
- `BACKOFFICE_OAUTH_CLIENT_SECRET`: the initial secret returned when creating that confidential
  client.
- `BOOKKEEPING_BASE_URL`: the Bookkeeping origin, e.g. `http://127.0.0.1:4173`.
- `BOOKKEEPING_OPERATOR_ORGANIZATION_ID`: the Backoffice organization whose members are the
  operators.

Create a dedicated confidential client in the **Backoffice terminal**, in System context, as a
global administrator (not in your host shell):

```sh
admin.oauth-clients.create --name Bookkeeping --application-type native --client-type confidential --redirect-uri http://127.0.0.1:4173/api/auth/callback/backoffice --scope openid --scope profile --scope email --scope offline_access --scope backoffice --client-credentials
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
and the actions declared in `workers/backoffice/actions.ts`, and writes the client ID, secret, and
both origins to `.dev.vars`. It then finds or creates the operator organization (slug
`bookkeeping-operators`; pass `--operators-slug` to choose another) with the signed-in administrator
as owner, installs Bookkeeping there, and writes its ID to `BOOKKEEPING_OPERATOR_ORGANIZATION_ID`.
Bookkeeping is registered as a first-party app with every provisioning permission: Backoffice skips
its consent screen and permission review, and Bookkeeping may create organizations and
administrations in Backoffice, and create, send, and accept invitations for its users (see
Backoffice's `app/fragno/apps/README.md`). It reads both origins from `.dev.vars` and defaults to
`http://127.0.0.1:5173` and `http://127.0.0.1:4173`; pass `--backoffice-url` or `--bookkeeping-url`
to change them, which also moves the callback and the action endpoint. The app is registered as
`app#bookkeeping`; pass `--slug` to choose another permanent name. Rerunning converges on the same
client and app, updating its requested permissions and actions in place; as a first-party app,
Bookkeeping has new permissions in every organization within a minute. Action changes apply
automatically to existing installations; pass `--change-approval installation` to make each
installation's owner approve them. Production requires HTTPS.

## Firms and clients

Bookkeeping has three layers, as Brand Intelligence does with ReJot, partners, and brand brains:

- **Operators** run Bookkeeping. They are the members of the operator organization, the Backoffice
  organization in `BOOKKEEPING_OPERATOR_ORGANIZATION_ID`, which Backoffice's administrator creates
  with `backoffice:connect`. Bookkeeping records it with kind `operator`. To anyone else,
  `/operator` does not exist. Operators invite more operators at `/operator/members`.
- **Firms** are accounting firms: Backoffice organizations Bookkeeping records with kind `firm`.
- **Clients** are the businesses whose books a firm keeps: Backoffice organizations Bookkeeping
  records with kind `client` and the firm that created them.

Backoffice owns the organizations, their members, and their roles (owner, admin, member);
Bookkeeping keeps a read-only copy in the `Directory` object and never changes membership itself.
The link from a client to its firm is Bookkeeping's alone: Backoffice does not know it, and grants
the firm nothing in the client. People sign up only through invitations: someone who signs in
without one has no access yet.

**Creating a firm.** At `/operator/firms/new`, an operator gives the firm's name and the email of
its owner, who need not have signed in yet. Bookkeeping provisions it with
`organizations.provisionForInvitee`: Backoffice creates the firm with no members and a pending owner
invitation from the operator, who does not become a member, and installs Bookkeeping there.
Bookkeeping then sends the invitation as any other. Operators open a firm only if its owners invite
them. An operator who names their own email owns the firm instead, provisioned with
`organizations.provision`. Resubmitting the form after a failure finds the same firm and the same
pending invitation.

**Creating a client.** Any firm member creates a client at `/f/:slug/clients/new`. Bookkeeping
provisions its organization with the creator as owner, records it under the firm, and opens its
members page to invite the client. Being a member of a firm does not open its clients: the firm's
dashboard lists every client, and its members open those they belong to. External IDs are prefixed
with the kind (`firm:`, `client:`), so a firm and a client never share one.

**Access.** Each request to a firm or client checks the person's membership, and that the slug is of
that kind. A membership Backoffice confirmed in the last minute is trusted; otherwise Bookkeeping
exchanges the person's Backoffice token for a credential in that organization
(`POST /api/backoffice/execution-token`) and reads their roles with `org.get`. When Backoffice
refuses, because they were removed or Bookkeeping was uninstalled, Bookkeeping forgets their
membership and answers 404; nothing is deleted. While Backoffice is unreachable, unconfirmed access
answers 503. Installed apps cannot ask which organizations someone belongs to, so `/start` and the
switcher show the memberships Bookkeeping recorded: from creating an organization, accepting an
invitation, or a confirmed visit.

**Members.** A firm's and a client's members pages list members with `org.members.list` and pending
invitations with `org.invitations.list`, as the viewer, and replace the copy's memberships with the
list. Members show the names people gave Bookkeeping.

**Inviting.** Owners and admins invite on the members page: Bookkeeping creates the invitation with
`invitations.create` as the inviter, so Backoffice applies their current role (only owners invite
owners). Apps cannot use `org.invitations.create`, which only people acting directly may. Backoffice
then emails the invitation in Bookkeeping's name with `invitations.send`, linking to
`/invitations/:invitationId`; the page shows the link too, to send by hand when Backoffice cannot
email, as a local Backoffice without Resend cannot. The invited person signs in there, with
Backoffice's sign-in page already showing the invited address; someone signed in with another
address is offered to log out first. They then join: Bookkeeping calls `invitations.accept`, and
Backoffice checks that the invitation is for their verified address. Someone who signs in without
the link finds their unexpired invitations on `/start`. Invitations made in Backoffice itself show
on the members page without a link; their invitees find the organization once they open it.

### Backoffice actions

Backoffice calls Bookkeeping too: an organization's members and agents run `organization.get`
through the `app#bookkeeping` integration connection, e.g.
`integrations.execute --connection-id 'app#bookkeeping' --action-id organization.get --input-json '{}'`,
or through a client from `integrations.generateClient`. `workers/backoffice/actions.ts` serves
`POST /api/backoffice/actions`: it verifies Backoffice's per-request token with
`createAppActionVerifier`, then describes the firm or client the request was signed for.

## Administrations

An administration is the books of one business. A client can have several, e.g. for a holding and
its subsidiaries; everyone in the client's workspace opens them, and owners and admins create them
at `/w/:slug/administrations/new` with a name and the currency the books are kept in. Creating one:

1. creates its Backoffice project with `projects.provision`, as the person creating it, so
   Backoffice agents can work on the administration in that project;
2. opens its books in a new `Books` object named by the project's ID (`workers/books`; see its
   README);
3. records it in the `Directory` object, which lists a client's administrations.

The form carries an identifier chosen when it was shown, and each step is idempotent, so submitting
it again after a failure, such as Backoffice being unreachable, finishes the steps left instead of
creating a second administration. Bookkeeping owns which projects are administrations: projects made
in Backoffice itself are not, and renaming or deleting a project there does not change the
administration.

## Layout

`app/` holds the React Router pages and `workers/` the Cloudflare Worker. Both are organized by
feature: a page sits with its server code and scenario tests, and each Durable Object has its own
folder with its migrations.

| Path                  | Holds                                                                 |
| --------------------- | --------------------------------------------------------------------- |
| `app/auth`            | the session, the auth client, and signing in and out                  |
| `app/public`          | pages outside the areas: home, login, help, name, account             |
| `app/shell`           | the frame every area shares, its modes, and the places someone can go |
| `app/organizations`   | `/start`, access confirmation, and provisioning firms and clients     |
| `app/operator`        | the operator's area: every firm, creating firms, and the operators    |
| `app/firms`           | a firm's area: its clients, creating clients, and its members         |
| `app/clients`         | a client's workspace: its administrations and its members             |
| `app/administrations` | creating and opening an administration                                |
| `app/members`         | a firm's or client's team: members, invitations, and inviting         |
| `app/invitations`     | inviting someone, and accepting an invitation                         |
| `workers/worker.ts`   | the Worker's `fetch` entry, which exports the Durable Objects         |
| `workers/auth`        | the `Auth` object                                                     |
| `workers/directory`   | the `Directory` object                                                |
| `workers/backoffice`  | Backoffice's API client and the actions Backoffice calls              |
| `workers/books`       | the `Books` object and its schema                                     |
| `scenario/`           | the scenario test harness                                             |

## Checks

```sh
pnpm types:check
pnpm test
pnpm build
```

Scenario tests (`*.scenario.test.ts`) run Bookkeeping's pages and Durable Objects in Node with
`scenario/bookkeeping-scenario.ts`:

- Durable Objects run their Cloudflare code unchanged on `FakeDurableObjectState`: `storage.sql` on
  in-memory SQLite, KV, transactions, alarms, and `blockConcurrencyWhile`. Calls cross a fake RPC
  boundary that copies arguments and results and keeps only errors' names and messages.
- `cloudflare:workers` resolves to `scenario/cloudflare-workers.ts`, whose `env` holds the running
  scenario's bindings.
- `FakeBackoffice` serves the Backoffice HTTP calls Bookkeeping makes, parsed with
  `@fragno-dev/backoffice-api`'s schemas; requests to any other origin fail.
- Browsers keep cookies and run Bookkeeping's routes through React Router's static handler, so
  layout loaders, actions, and redirects behave as in production.
- `practice()` sets up an operator, a firm whose owner accepted the invitation, and its first
  client; `advanceTime()` moves the clock.

## Deployment

From `apps/bookkeeping`, set the production URL and a separate production secret:

```sh
pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put BOOKKEEPING_BASE_URL
pnpm exec wrangler secret put BACKOFFICE_BASE_URL
pnpm exec wrangler secret put BACKOFFICE_OAUTH_CLIENT_ID
pnpm exec wrangler secret put BACKOFFICE_OAUTH_CLIENT_SECRET
pnpm exec wrangler secret put BOOKKEEPING_OPERATOR_ORGANIZATION_ID
pnpm deploy
```

Set `BOOKKEEPING_BASE_URL` to the final HTTPS origin (your Workers URL or custom domain). Do not use
the example secret in production. Deployments create the SQLite Durable Object namespaces. The `v4`
migration deletes the former `Workspaces` and `Workflows` objects and their data, which self-serve
sign-up created.

## Schema

Each Durable Object applies versioned SQL migrations in order before serving requests; each one
commits atomically with its version. They use Fragno's Kysely Durable Object dialect, which does not
support Better Auth migration introspection, so schema changes are new migration files rather than
edits to existing ones.

Each object's migrations are numbered files in its `migrations/` folder. An object records how many
it has applied, not their names.

- `workers/auth/migrations/0001-better-auth.sql`: Better Auth 1.7.1's default schema for users,
  sessions, and accounts.
- `0002-organizations.sql` and `0003-backoffice-owner.sql`: Bookkeeping's former organizations and
  their links to Backoffice, which `0004-drop-organizations.sql` drops.
- `workers/directory/migrations/0001-directory.sql`: the `Directory` object's organizations,
  memberships, invitations, and administrations, and `0002-operators.sql` the `operator` kind.
- `Books` applies `bookkeepingSchema` from `workers/books/schema.ts` as its first migration.
