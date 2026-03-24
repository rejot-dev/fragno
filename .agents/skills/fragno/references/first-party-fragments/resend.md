# Resend Fragment (@fragno-dev/resend-fragment)

## Summary

Email fragment for sending, receiving, and threading mail while keeping a canonical local message
store in your database.

## Use when

- Your product sends transactional or human-authored email.
- You need inbound webhooks and owned thread history.
- You want typed APIs over domains, outbound mail, inbound mail, and reply flows.

## Config

The fragment config covers Resend credentials, defaults, and webhook callbacks.

What you provide:

- `apiKey`: Resend API key.
- `webhookSecret`: secret for verifying webhook requests.
- `defaultFrom` (optional): default sender.
- `defaultReplyTo` (optional): default reply-to header(s).
- `threadReplyBaseAddress` (optional): base reply address for thread routing.
- `defaultTags` and `defaultHeaders` (optional): default metadata on outgoing mail.
- `onEmailStatusUpdated` (optional): callback for provider status changes.
- `onEmailReceived` (optional): callback for inbound messages.

What the fragment needs via options:

- `databaseAdapter`: required for domains, canonical email messages, and threads.
- `mountRoute` (optional): choose where the fragment is mounted.

## What you get

- Outbound email sending.
- Inbound webhook processing.
- Canonical local message/thread history.
- Typed hooks for domains, emails, received emails, threads, and replies.

## Docs

There is not yet a published Markdown docs section for Resend. Use these local references first:

- `apps/docs/app/routes/resend.tsx`
- `packages/resend-fragment/README.md`
- `packages/resend-fragment/src/index.ts`
- `packages/resend-fragment/src/definition.ts`

## Prerequisites

- A Resend account and verified sending domain.
- A database and `@fragno-dev/db` adapter.
- A public webhook endpoint if you want inbound/status events.

## Install

`npm install @fragno-dev/resend-fragment @fragno-dev/db`

## Server setup

1. Create a DB adapter.
2. Instantiate the fragment with API credentials and defaults.
3. Mount routes in your framework.
4. Configure Resend webhooks to hit the mounted webhook route.
5. Generate and apply DB migrations.

Example server module:

```ts
import { createResendFragment } from "@fragno-dev/resend-fragment";
import { databaseAdapter } from "./db";

export const resendFragment = createResendFragment(
  {
    apiKey: process.env.RESEND_API_KEY!,
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
    defaultFrom: "Support <support@example.com>",
    onEmailReceived: async ({ threadId, emailMessageId }) => {
      console.log("Inbound email", emailMessageId, "thread", threadId);
    },
  },
  {
    databaseAdapter,
    mountRoute: "/api/resend",
  },
);
```

## Database migrations

Generate schema/migrations:

- `npx fragno-cli db generate lib/resend.ts --format drizzle -o db/resend.schema.ts`
- `npx fragno-cli db generate lib/resend.ts --output migrations/001_resend.sql`

## Client setup

Use the framework-specific client entrypoint, e.g. React:

```ts
import { createResendFragmentClient } from "@fragno-dev/resend-fragment/react";

export const resendClient = createResendFragmentClient({
  mountRoute: "/api/resend",
});
```

## Routes and hooks

Routes:

- `POST /webhooks`
- `GET /domains`
- `GET /domains/:domainId`
- `GET /emails`
- `GET /emails/:emailId`
- `POST /emails`
- `GET /received-emails`
- `GET /received-emails/:emailId`
- `GET /threads`
- `POST /threads`
- `GET /threads/:threadId`
- `GET /threads/:threadId/messages`
- `POST /threads/:threadId/reply`

Hooks/mutators:

- `useDomains`
- `useDomain`
- `useReceivedEmails`
- `useReceivedEmail`
- `useThreads`
- `useCreateThread`
- `useThread`
- `useThreadMessages`
- `useReplyToThread`
- `useEmails`
- `useEmail`
- `useSendEmail`

## Operational notes

- Thread timelines read from canonical local `emailMessage` rows.
- Webhook callbacks expose canonical local IDs plus provider IDs where available.
- Status and inbound events should be considered asynchronous side effects.

## Common pitfalls

- Forgetting to configure Resend webhook delivery to the fragment route.
- Expecting provider message IDs to replace local canonical message IDs.
- Not applying migrations before the first outbound/inbound event.

## Next steps

- Build inbox/support tooling on top of thread routes.
- Connect inbound email hooks to workflows or ticketing logic.
