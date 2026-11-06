# @fragno-dev/resend-fragment

Resend full-stack library: send transactional email, handle **Resend webhooks** (signature
verification and idempotent processing), persist **inbound mail** and **thread state** in your own
database, and drive inboxes from **typed client hooks** (React, Vue, Svelte, Solid, or vanilla JS).

Think of it as turning Resend from a transport SDK into application infrastructure: backend routes,
database-backed canonical storage, and frontend hooks on one surface.

## Who is this for?

Application developers who want email sending, delivery status, inbound receipt, and threaded
conversations without stitching together webhooks, retries, and ad hoc projections.

You supply credentials and a Fragno DB adapter; the fragment exposes routes and client hooks.

## Documentation

- **[Resend quickstart](https://fragno.dev/docs/resend/quickstart)** — install, DB adapter, mount
  handlers, schema generation, middleware, webhook registration, and client setup for each
  framework.
- **[Using the library](https://fragno.dev/docs/resend/using)** — hooks, sending mail, and runtime
  behavior.
- **[Resend fragment (overview)](https://fragno.dev/fragments/resend)** — feature summary and setup
  blueprint.

Broader Fragno docs: [fragno.dev/docs](https://fragno.dev/docs).

## Prerequisites

- A [Resend](https://resend.com) API key and **webhook signing secret**
- For sending: a **verified** `from` address (see `defaultFrom` in config)
- [`@fragno-dev/db`](https://fragno.dev/docs/fragno/for-users/database-fragments/overview) with an
  adapter matching your database (PostgreSQL, SQLite, MySQL, Durable Objects SQLite, etc.)

## Agent-assisted setup

Install the Fragno agent skill and ask your agent to integrate the fragment:

```bash
npx skills add https://github.com/rejot-dev/fragno --skill fragno
```

Example prompt: **"Integrate the Resend fragment into my application"**

## Features

- **Send email** — transactional sends via Resend without blocking your request flow on downstream
  delivery.
- **Webhooks** — verified inbound events, retries, and status sync packaged in the fragment.
- **Inbound email** — body and metadata persisted locally when mail is received.
- **Mailboxes** — one receiving address per owner you name, so received mail says whose it is.
- **Threading** — replies grouped into timelines using reply tokens, headers, and subject
  heuristics.
- **Frontend hooks** — typed hooks for domains, emails, threads, messages, and replies.
- **Local canonical store** — durable email and thread data in **your** database.

## How was this made?

[Fragno](https://fragno.dev) is a toolkit for building full-stack libraries. It lets libraries
define database schemas, API routes, and frontend hooks, enabling easy integration into
applications.

Read the full essay
["Receiving Resend inbound email without webhooks"](https://fragno.dev/fragments/resend/essay) to
learn more about the motivation and the design decisions behind this library.

## Manual installation

```bash
npm install @fragno-dev/resend-fragment @fragno-dev/db
```

Install the CLI to generate schema and migrations for your ORM:

```bash
npm install --save-dev @fragno-dev/cli
```

Then follow the full walkthrough (database adapter, schema generation, middleware, webhook URL) in
the docs—see [Documentation](#documentation).

## Quick start (sketch)

**1. Create the server** — configure API key, webhook secret, defaults, and optional lifecycle
callbacks (`onEmailReceived`, `onEmailStatusUpdated`):

```ts
import { createResendFragment } from "@fragno-dev/resend-fragment";
import { fragmentDbAdapter } from "@/db/fragno";

export const resendFragment = createResendFragment(
  {
    apiKey: process.env.RESEND_API_KEY!,
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
    defaultFrom: "Support <support@example.com>",
    onEmailReceived: async ({ emailMessageId, threadId }) => {
      console.log("Inbound email", emailMessageId, threadId);
    },
  },
  {
    databaseAdapter: fragmentDbAdapter,
    mountRoute: "/api/resend",
  },
);
```

Set `defaultFrom` unless every send call provides `from`. If you change `mountRoute`, use the
**same** value in the client.

**2. Mount HTTP handlers** — wire the fragment once for your framework. Example (React Router v7):

```ts
import { resendFragment } from "@/lib/resend";

export const handlers = resendFragment.handlersFor("react-router");
export const action = handlers.action;
export const loader = handlers.loader;
```

Other frameworks (Next.js, Nuxt, Astro, SvelteKit, Hono, …) are supported—see
[Frameworks](https://fragno.dev/docs/fragno/reference/frameworks).

**3. Generate schema** — e.g. Drizzle:

```bash
npx fragno-cli db generate lib/resend.ts --format drizzle -o db/resend.schema.ts
```

**4. Create the client** — point `mountRoute` at your mounted API prefix:

```ts
import { createResendFragmentClient } from "@fragno-dev/resend-fragment/react";

export const resendClient = createResendFragmentClient({
  mountRoute: "/api/resend",
});
```

Framework entrypoints: `@fragno-dev/resend-fragment/react` | `/vue` | `/svelte` | `/solid` |
`/vanilla`.

**5. Secure routes** — use Fragno [middleware](https://fragno.dev/docs/fragno/for-users/middleware)
for authenticated APIs. **Do not** put your user session on the **webhook** route: Resend calls it
from their infrastructure; the fragment validates `webhookSecret` and Svix signatures instead.

**6. Register the webhook** in the Resend dashboard—for mount route `/api/resend`, use:

```text
https://your-app.com/api/resend/webhook
```

The fragment listens for `email.*` events.

## Mailboxes

Give each of your users one receiving address on a domain whose MX records point at Resend. A
mailbox maps one address to an `owner` string the fragment stores but never interprets, such as your
user ID, and each owner has at most one. `onEmailReceived` runs with
`recipientMailbox: { address, owner }` once for each owner whose current, unpaused address Resend
delivered the mail to, or once with `null` when it reached none; the fragment stores the mail once
either way. Resend may report an email again, such as once per recipient: each report reaches only
owners not yet reached. `getMailboxEmail({ emailMessageId, owner })` reads a stored message, with
its bodies and headers, only for an owner of an address it was delivered to.

```ts
const result = await resendFragment.callServices(() =>
  resendFragment.services.openMailbox({
    owner: user.id,
    address: "quiet-amber-falcon@inbound.example.com",
  }),
);
// { status: "opened", mailbox } | { status: "taken" } | { status: "invalid", message }
```

- `openMailbox` gives an owner without a mailbox one at `address`. An owner with one gets it back,
  resumed if paused, and `address` is ignored, so an owner keeps one address.
- `pauseMailbox(owner)` stops delivery; the mailbox keeps its address.
- `replaceMailboxAddress({ owner, address })` moves a mailbox to a new address.
- `getMailbox(owner)` and `findMailbox(address)` read mailboxes.
- `onMailboxChanged(mailbox, context)` receives each change, as `{ owner, address, paused }`: a
  mailbox opened, resumed, paused, or moved. A durable hook, triggered in the transaction that makes
  the change, delivers it and retries until it succeeds.
- Concurrent calls settle as if made one after another: two opens for one owner return the same
  mailbox, and of two owners claiming one address, one gets `taken`.
- An address is issued once: after it is replaced, no owner can get it again, so mail people still
  send there reaches no one new.
- Addresses are lowercased. Local parts may not contain `+`, which marks thread reply addresses, or
  be a role that can act for the domain, such as `postmaster` or `admin`.

## Development

From the monorepo root:

```bash
pnpm exec turbo types:check --filter=@fragno-dev/resend-fragment --output-logs=errors-only
pnpm exec turbo test --filter=@fragno-dev/resend-fragment --output-logs=errors-only
```
