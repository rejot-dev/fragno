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

| Path                           | What                                                                     |
| ------------------------------ | ------------------------------------------------------------------------ |
| `/`                            | Public frontpage                                                         |
| `/login`, `/help`              | Signing in, and help with signing in; `/signup` redirects to `/login`    |
| `/name`                        | Asks a new person's name                                                 |
| `/start`                       | Where signing in lands: one place, or a choice of places and invitations |
| `/account`                     | Who is signed in, and logging out                                        |
| `/invitations/:invitationId`   | Joining a firm or a client                                               |
| `/operator`                    | Every firm, for operators only; `/operator/firms/new` creates one        |
| `/operator/members`            | The operators, and inviting more                                         |
| `/f/:slug`                     | A firm's clients; `/f/:slug/clients/new` creates one                     |
| `/f/:slug/members`             | The firm's members and invitations                                       |
| `/w/:slug`                     | A client's workspace: its administrations                                |
| `/w/:slug/administrations/new` | Creating an administration                                               |
| `/w/:slug/a/:administration`   | An administration's books, opening on its journal; see [Books](#books)   |
| `/w/:slug/members`             | The client's members and invitations                                     |
| `/api/auth/*`                  | Better Auth, served by the `Auth` object                                 |

The operator, firm, and client areas share a frame: a collapsible desktop sidebar, mobile
navigation, and a switcher between every place the person can go. Pages that require a session send
signed-out visitors to `/login?returnTo=<page>`, and people without a name to
`/name?returnTo=<page>`; both continue to that page, and only to Bookkeeping's own pages. Signed-in
visitors at `/login` continue to its `returnTo`. When Backoffice no longer accepts Bookkeeping's
authorization, the page sends them to `/login?reauthorize=1&returnTo=<page>` to sign in again.
Personalized route responses are marked private and non-cacheable.

Signing in requires JavaScript.

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
one in `.dev.vars`: callback URL, scopes, and client credentials), registers the app with
`org.read`; `upload.read` and `upload.modify` (for [documents](#documents)); `pi.manage`,
`pi.modify`, `pi.read`, `models.extract`, `integrations.read`, and `integrations.execute` (for the
[bookkeeping agent](#the-bookkeeping-agent)); and the actions declared in
`workers/backoffice/actions.ts`, and writes the client ID, secret, and both origins to `.dev.vars`.
It then finds or creates the operator organization (slug `bookkeeping-operators`; pass
`--operators-slug` to choose another) with the signed-in administrator as owner, installs
Bookkeeping there, and writes its ID to `BOOKKEEPING_OPERATOR_ORGANIZATION_ID`. Bookkeeping is
registered as a first-party app with every provisioning permission: Backoffice skips its consent
screen and permission review, and Bookkeeping may create organizations and administrations in
Backoffice, and create, send, and accept invitations for its users (see Backoffice's
`app/fragno/apps/README.md`). It reads both origins from `.dev.vars` and defaults to
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
- **Clients** are the businesses whose books a firm keeps: Backoffice organizations the firm
  manages, which Bookkeeping records with kind `client` and their firm.

Backoffice owns the organizations, their members, and their roles (owner, admin, member);
Bookkeeping keeps a read-only copy in the `Directory` object and never changes membership itself.
Backoffice also records that a firm manages its clients: every member of the firm acts in each
client with their role in the firm, owners as admins, without becoming the client's member. The
`Directory` keeps the firm of each client as Bookkeeping provisioned it. Operators manage no firms:
an operator organization managing them would reach each firm's agent project and the skills in it.
People sign up only through invitations: someone who signs in without one has no access yet.

**Creating a firm.** At `/operator/firms/new`, an operator gives the firm's name and the email of
its owner, who need not have signed in yet. Bookkeeping provisions it with
`organizations.provisionForInvitee`: Backoffice creates the firm with no members and a pending owner
invitation from the operator, who does not become a member, and installs Bookkeeping there.
Bookkeeping then sends the invitation as any other. Operators open a firm only if its owners invite
them. An operator who names their own email owns the firm instead, provisioned with
`organizations.provision`. Resubmitting the form after a failure finds the same firm and the same
pending invitation.

**Creating a client.** The firm's owners and admins create a client at `/f/:slug/clients/new`.
Bookkeeping provisions it with `organizations.provisionManaged`, managed by the firm and with no
members or owner yet, with the creator recorded as its creator, records it under the firm, and opens
its members page to invite the client's owner. The firm's dashboard lists every client, and every
member of the firm opens each. External IDs are prefixed with the kind (`firm:`, `client:`), so a
firm and a client never share one. Clients created before Backoffice recorded management have their
creator as owner and no manager; Backoffice's administrator gives each its firm with
`admin.org.manager.set --org <client> --manager <firm>`.

**Access.** Each request to a firm or client checks the person's membership, or in a client their
firm's, and that the slug is of that kind. A membership Backoffice confirmed in the last minute is
trusted; otherwise Bookkeeping exchanges the person's Backoffice token for a credential in that
organization (`POST /api/backoffice/execution-token`) and reads their roles, and whether they act
through the firm, with `org.get`. When Backoffice refuses, because they were removed or Bookkeeping
was uninstalled, Bookkeeping forgets their membership and answers 404; nothing is deleted. While
Backoffice is unreachable, unconfirmed access answers 503. Installed apps cannot ask which
organizations someone belongs to, so `/start` and the switcher show the memberships Bookkeeping
recorded: from creating an organization, accepting an invitation, or a confirmed visit. Clients
someone reaches through their firm are not among them: the firm's dashboard lists those.

**Members.** A firm's and a client's members pages list members with `org.members.list` and pending
invitations with `org.invitations.list`, as the viewer, and replace the copy's memberships with the
list; the firm's people a client does not list keep their own confirmation. Members show the names
people gave Bookkeeping.

**Inviting.** Owners and admins invite on the members page: Bookkeeping creates the invitation with
`invitations.create` as the inviter, so Backoffice applies their current role (only owners invite
owners). In a client, the firm's owners and admins invite as its admins, and invite its owner while
it has none. Apps cannot use `org.invitations.create`, which only people acting directly may.
Backoffice then emails the invitation in Bookkeeping's name with `invitations.send`, linking to
`/invitations/:invitationId`; the page shows the link too, to send by hand when Backoffice cannot
email, as a local Backoffice without Resend cannot. The invited person signs in there, with
Backoffice's sign-in page already showing the invited address; someone signed in with another
address is offered to log out first, and Backoffice then asks them to sign in rather than return the
other account, since the invited address is the login hint. They then join: Bookkeeping calls
`invitations.accept`, and Backoffice checks that the invitation is for their verified address.
Someone who signs in without the link finds their unexpired invitations on `/start`. Invitations
made in Backoffice itself show on the members page without a link; their invitees find the
organization once they open it.

### Backoffice actions

Backoffice calls Bookkeeping too: an organization's members and agents run `organization.get`
through the `app#bookkeeping` integration connection, e.g.
`integrations.execute --connection-id 'app#bookkeeping' --action-id organization.get --input-json '{}'`,
or through a client from `integrations.generateClient`. `workers/backoffice/actions.ts` serves
`POST /api/backoffice/actions`: it verifies Backoffice's per-request token with
`createAppActionVerifier`, then describes the firm or client the request was signed for.

Agents also keep an administration's books with the actions in
`workers/backoffice/books-actions.ts`, one per operation of its pages. Each declares zod input and
output schemas, which registration sends as JSON Schema and the handler parses with. They run in the
administration's Backoffice project, where the signed project picks the books; or, for the
[bookkeeping agent](#the-bookkeeping-agent), in the agent project of the firm keeping them, where
every input names the administration as `administration` and Bookkeeping checks that it is one of
the firm's clients'. Calls in any other scope are refused. Inputs name accounts, journals,
customers, suppliers, and dimensions by code and amounts as decimals; `books.describe` lists them.

| Access                       | Actions                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone Backoffice signs for  | `books.describe`, `entries.list`, `entries.get`, `accounts.lines`, `reports.trial-balance`, `parties.open-items`, `documents.get`                                |
| Members and the installation | `documents.propose`, `documents.decline`                                                                                                                         |
| Members                      | `entries.post`, `entries.reverse`, `parties.create`, `settlements.create`, `settlements.reverse`                                                                 |
| Owners and admins            | `accounts.create`, `accounts.update`, `journals.create`, `dimensions.create`, `dimension-values.create`, `currencies.add`, `fiscal-years.open`, `periods.reopen` |

Only people close and lock periods, on the settings page. Changing the books needs a person: calls
Backoffice makes as the installation, for automations such as the
[bookkeeping agent](#the-bookkeeping-agent), only read and answer documents' reviews, which posts
nothing. In a firm's agent project only the installation's calls are taken: people keep their
clients' books in the clients' projects. The person must have signed in to Bookkeeping, which names
them on the entries and settlements their agent makes ("Ada Lovelace via Backoffice"). Their roles
are confirmed as the pages confirm them: a membership Backoffice confirmed within the last minute is
trusted, otherwise Bookkeeping asks Backoffice again with their stored authorization. An entry's
reference, such as an invoice number, is unique in its journal, so an agent posting again after a
lost answer cannot post twice. The ledger's refusals answer HTTP 422 with its message, which
Backoffice passes to the agent.

After changing the actions, run `pnpm backoffice:connect` to register them.

## Administrations

An administration is the books of one business. A client can have several, e.g. for a holding and
its subsidiaries; everyone in the client's workspace opens them, and owners and admins create them
at `/w/:slug/administrations/new` with a name and the currency the books are kept in. Creating one:

1. creates its Backoffice project with `projects.provision`, as the person creating it, so
   Backoffice agents can work on the administration in that project;
2. opens its books in a new `Books` object named by the project's ID (`workers/books`; see its
   README), ready to post to: this calendar year in monthly periods, journals for general, sales,
   purchase, and bank entries, and a small chart of accounts;
3. records it in the `Directory` object, which lists a client's administrations.

The form carries an identifier chosen when it was shown, and each step is idempotent, so submitting
it again after a failure, such as Backoffice being unreachable, finishes the steps left instead of
creating a second administration. Bookkeeping owns which projects are administrations: projects made
in Backoffice itself are not, and renaming or deleting a project there does not change the
administration.

## Books

An administration's books are the double-entry ledger of `@fragno-dev/ledger`
(`packages/fragment-ledger`), which runs in its `Books` object. The ledger enforces the rules:
entries balance and are final once posted, periods must be open, lines on receivable and payable
accounts belong to a customer or supplier. The pages under `/w/:slug/a/:administration` show its
refusals as form errors:

| Path                                   | What                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| the books' own path                    | A journal's entries, newest first; `?journal=` picks the journal                                  |
| `/entries/:journal/:entryNumber`       | One entry, named by its journal's code, e.g. `/entries/SAL/3`, and reversing it                   |
| `/entries/new`                         | Posting an entry: its lines, with a customer or supplier, currency, and dimension values          |
| `/documents`, `/documents/:documentId` | Uploading documents and listing them; one document, its proposed entry, booking it, or dismissing |
| `/accounts`, `/accounts/:accountId`    | The chart of accounts and adding to it; an account's lines, and renaming or deactivating it       |
| `/trial-balance`                       | Each account's totals for the fiscal year through a period; `?period=` picks it                   |
| `/parties`, `/parties/:partyAccountId` | Customers and suppliers; one's open items, settling them against each other, and undoing that     |
| `/settings`                            | Fiscal years, and closing, reopening, or locking their periods; journals, dimensions, currencies  |

The client's sidebar lists these pages under the administration's name while its books are open.
Everyone in the client's workspace keeps the books: posting and reversing entries, adding customers
and suppliers, and settling their items. A reversal settles the open items of the entry it reverses.
Owners and admins also set them up: the calendar, journals, dimensions, currencies, and chart of
accounts. Entries and settlements record the name of the person who made them. Amounts are entered
as decimals with a dot or a comma and no thousands separators.

### Documents

Members upload the books' documents, such as invoices and receipts, at `/documents`, and book each
from its page: **Book** opens the new-entry form beside the document, with the document's date to
fill in. Uploading also asks the [bookkeeping agent](#the-bookkeeping-agent) to propose the entry.
Booking posts the entry and records the document as its source document in the ledger, in one
transaction (`workers/books/documents`, a Fragno fragment that uses the ledger's services). A
document is booked once: reversing its entry makes it to book again, and booking it again keeps the
date it was first booked with. Reversing that reversal books the document again too, so it is
refused unless the document is to book. A document that is not to be booked, such as a duplicate, is
dismissed; a booked one is not. An entry's page links to the document it books.

Documents' files live in the administration's Backoffice project, at
`/workspace/documents/<document ID>/<SHA-256>/<filename>`, where its agents work too. Bookkeeping
stores and reads them as the person, with `state.writeFileBytes` and `state.readFileBytes`, and
serves them at `/documents/:documentId/file`. It accepts PDFs and PNG, JPEG, and WebP images, by
their first bytes rather than the type the browser sends, of at most 1.9 MB: Backoffice keeps each
workspace file in one Durable Object SQLite row. It records each file's SHA-256 hash, and refuses to
show a file changed or deleted in Backoffice since its upload. The upload form carries an ID chosen
when it was shown, and the file is stored before the document is recorded, so uploading again after
a failure records the document once. Backoffice's writes have no precondition, so the path names the
file's hash: another file sent with the same form is stored beside the document's, never over it.
The upload's body is read only up to the largest upload, so a larger one is refused unread.

#### The bookkeeping agent

Uploading a document asks the `bookkeeper` agent of the firm keeping the books to propose the entry
booking it. The agent lives in the firm's own Backoffice project, `Bookkeeping agent`, so the skills
the firm gives it never reach a client's workspace, where the client could read them. Bookkeeping
provisions that project the first time one of the firm's owners or admins opens the firm, since
Backoffice creates a project as a member of the firm who authorized Bookkeeping; until then, asking
the agent says the firm has not set it up.

To ask, Bookkeeping shares the document's folder from the administration's project with the firm's
agent project (`state.share`), which mounts it read-only at `/shared/document-<hash>/`
(`state.acceptShare`); asking again reuses the share that stands. A document's ID is unique only in
its administration, and the firm's agent serves all its clients, so the mount's name hashes the
administration's ID with the document's, and the prompt's request ID names both. Answering the
review revokes the share, as does the document's page when it shows a document whose review was
answered, or that was booked or dismissed, so the firm reads a client's file only while it is asked
about it. Bookkeeping asks as its installation, not as the person, so the agent's calls to
Bookkeeping arrive as the installation's: they read the books and answer reviews
(`documents.propose` and `documents.decline`), and every other change is refused, whatever a
document tells the agent. Bookkeeping defines the agent when the firm's project has none, granting
it `upload.read`, `models.extract`, `integrations.read` (to read the actions' input schemas), and
`integrations.execute`; a definition the firm's members changed in Backoffice is left as it is. So
is one Bookkeeping defined before its definition changed: members update or delete it to get the new
one. It then submits the prompt, naming the administration and where the file is shared, with
`pi.prompt.submit` as a `subagent`: each document runs in a new conversation of the agent, beside
the others, so documents uploaded together are read side by side and no document sees another's
text. Backoffice bills the turn to the firm.

The agent reads the document with `documents.get` and `models.extract`, the books with
`books.describe` and `entries.list`, and answers with `documents.propose`, an entry as
`entries.post` takes it that must balance, or with `documents.decline` and why. It cannot post:
people review proposals. The document's page shows the proposal and the agent's note, and **Review
and book** opens the new-entry form filled in from it; the documents list marks documents with a
proposal. A proposal is checked against the books when made, and again by the ledger when booked.

Each document records its review: asked, under a request ID; the proposed entry; or the reason it
proposes none. The request is recorded before the agent is set up and asked, so one that never
reached it shows. While it is unanswered the document's page asks Backoffice where it stands with
`pi.prompt.get`: waiting, running, failed with the reason, finished without an answer, or never
received; or that Backoffice cannot say, e.g. while it cannot be reached. The agent answers before
its turn ends, so the page reads the document again before showing a finished turn without an
answer. While waiting or running, the page asks again every 5 seconds while it is in view, since
nothing tells Bookkeeping when the agent's turn ends. Any but the first two offer **Ask again**,
which sends a new request. The prompt names its request, and the agent's answer names it back: an
answer counts only while the document awaits that request, so an earlier request's subagent still
running, or one that can no longer read the file once the first answer stopped sharing it, cannot
replace the answer. A person's agent may answer without a request, replacing any answer. The upload
asks under one request ID, and only while the document has no review, so sending it again, even
twice at once, asks once and never undoes an answer. Booking or dismissing a document ends its
review: the agent's actions refuse documents that are not to book.

Bookkeeping is not live, so its storage keeps no compatibility: books are set up only when their
administration is created, and administrations from before a storage change do not open. Delete
`.wrangler/state` to start over locally.

## Layout

`app/` holds the React Router pages and `workers/` the Cloudflare Worker. Both are organized by
feature: a page sits with its server code and scenario tests, and each Durable Object has its own
folder with its migrations.

| Path                  | Holds                                                                    |
| --------------------- | ------------------------------------------------------------------------ |
| `app/auth`            | the session, the auth client, and signing in and out                     |
| `app/public`          | pages outside the areas: home, login, help, name, account                |
| `app/shell`           | the frame every area shares, its modes, and the places someone can go    |
| `app/organizations`   | `/start`, access confirmation, and provisioning firms and clients        |
| `app/operator`        | the operator's area: every firm, creating firms, and the operators       |
| `app/firms`           | a firm's area: its clients, creating clients, and its members            |
| `app/clients`         | a client's workspace: its administrations and its members                |
| `app/administrations` | creating an administration                                               |
| `app/books`           | an administration's books: journal, accounts, reports, parties, setup    |
| `app/documents`       | an administration's documents: uploading, booking, and their files       |
| `app/members`         | a firm's or client's team: members, invitations, and inviting            |
| `app/invitations`     | inviting someone, and accepting an invitation                            |
| `workers/worker.ts`   | the Worker's `fetch` entry, which exports the Durable Objects            |
| `workers/auth`        | the `Auth` object                                                        |
| `workers/directory`   | the `Directory` object                                                   |
| `workers/backoffice`  | Backoffice's API client and the actions Backoffice calls, books ones too |
| `workers/books`       | the `Books` object, the books it opens, its documents, the reference SQL |
| `scenario/`           | the scenario test harness                                                |

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
- `scenario/fixtures/invoice.pdf` is a realistic one-page purchase invoice to Analytical Engines,
  with four lines at 21% and 9% VAT, to upload in scenarios or by hand.
  `scenario/fixtures/invoice.ts` renders it and exports `INVOICE`, what it says, to compare an
  extraction with; after changing it, `pnpm fixtures:generate` writes the PDF again, byte for byte
  the same when nothing changed.

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
- `Books` holds the tables of the ledger fragment and of the documents fragment, which Fragno's
  `migrate` creates and upgrades when the object starts.
