---
name: resend-integration
description: >
  Use Resend through integrations.* (backoffice#resend) or the resend.* runtime tools. Load with
  configuring-integrations for email setup; also use for email threads, replies, Resend webhooks,
  and durable-hook debugging.
---

# Resend Integration

Use this skill for organization-scoped Resend email delivery, email thread state, and reply
automation. The organization's configuration is addressed as `backoffice#resend`. In system scope,
the same address is the platform account Backoffice sends its own email through, such as email
verification: disconnecting or misconfiguring it stops that email for every user.

# Resend configuration

Configuration fields:

- `apiKey`: Resend API key. Secret; required on first setup.
- `defaultFrom`: default sender address; required on first setup.
- `defaultReplyTo`: optional reply-to address or list of addresses.
- `webhookBaseUrl`: public Backoffice origin or tunnel URL used for Resend webhooks.

Setup notes:

- Use a verified sender/domain for `defaultFrom`.
- The webhook base URL must be reachable by Resend.
- Integration setup takes `{ apiKey, defaultFrom, defaultReplyTo }`, with `defaultReplyTo` a list
  that may be empty, and registers this deployment's public URL as the webhook. A tunnel URL is only
  available through `connections.*`.
- Resend must accept the webhook before anything is saved. A rejection returns `needs-input` with
  Resend's message and keeps the previous configuration.
- `integrations.verify({ connectionId: "backoffice#resend" })` reads the registered webhook from
  Resend and fails unless it is enabled and points at this deployment.

# Resend events

Saving a configuration reports `connection.ready` and resetting it reports
`connection.disconnected`, both with `source: "integrations"`, `subject.service: "resend"`, and
`subject.connectionId: "backoffice#resend"`.

Resend maintains email thread state and hook work behind the `resend` hook scope.

# Resend tools

Resend tools can:

- list email threads;
- load a thread with messages and a Markdown snapshot;
- send a plain-text reply to an existing thread.

In new automations, call them as integration actions on `backoffice#resend`: `threads.list`,
`threads.get`, and `threads.reply`. Read their schemas with `integrations.actions`. The `resend`
provider's thread functions remain for existing automations; see
`/static/codemode/providers/resend.d.ts`.
