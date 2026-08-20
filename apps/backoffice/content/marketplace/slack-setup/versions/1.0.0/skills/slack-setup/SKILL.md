---
name: slack-setup
description:
  Set up or verify Slack in Backoffice for bot-token API calls, sending messages, Events API
  webhooks, app mentions, URL verification, signing-secret validation, or checking whether a Slack
  event arrived.
---

# Slack setup

Set Slack up as one handshake: **connect → verify → receive → prove**.

## 1. Inspect existing API connections

The API capability is available automatically for the current scope. Inspect the existing outbound
API connections before creating or updating the Slack connection.

**Complete when** the existing outbound connections are known.

## 2. Collect missing secrets

Collect secrets through a durable Backoffice UI rather than chat. Define a workflow and return this
exact shape from a completed `step.do`, including only the controls for secrets still missing:

```js
await step.do("request Slack credentials", async () => ({
  $ui: {
    version: 1,
    state: { response: { botUserOAuthToken: "", signingSecret: "" } },
    spec: {
      root: "form",
      elements: {
        form: {
          type: "Stack",
          props: { gap: "md" },
          children: ["bot-token", "signing-secret", "submit"],
        },
        "bot-token": {
          type: "TextInput",
          props: {
            label: "Bot User OAuth Token",
            description: "Slack token beginning with xoxb-.",
            value: { $bindState: "/response/botUserOAuthToken" },
            required: true,
            secret: true,
          },
          children: [],
        },
        "signing-secret": {
          type: "TextInput",
          props: {
            label: "Signing Secret",
            description: "Slack App → Basic Information → App Credentials.",
            value: { $bindState: "/response/signingSecret" },
            required: true,
            secret: true,
          },
          children: [],
        },
        submit: {
          type: "WorkflowEventButton",
          props: {
            label: "Connect Slack",
            eventType: "slack.credentials-submitted",
            payload: { $state: "/response" },
          },
          children: [],
        },
      },
    },
  },
}));

const credentials = await step.waitForEvent("Slack credentials", {
  type: "slack.credentials-submitted",
});
```

Use `credentials.payload.botUserOAuthToken` and `credentials.payload.signingSecret` only inside
later `step.do` calls. Keep them out of workflow output, tool summaries, and prose.

**Complete when** the workflow has received every missing secret through
`slack.credentials-submitted`.

## 3. Connect the Slack bot

Use an existing active API connection whose slug is `slack`. Otherwise use the submitted **Bot User
OAuth Token** to create this connection:

```js
await api.createConnection({
  slug: "slack",
  name: "Slack",
  baseUrl: "https://slack.com/api",
  auth: { type: "bearer", token: botUserOAuthToken },
});
```

Treat tokens as secrets: use the exact user-supplied value only in the tool call and omit it from
results and prose. Verify the connection with `api.getAuthStatus`, then call Slack's
`POST /auth.test` with an empty JSON body. Slack API calls can return HTTP 200 for failures, so
require both HTTP 200 and `body.ok === true`.

If verification fails, report Slack's `error` value and stop. Never replace a missing token with a
placeholder or test credential.

**Complete when** authentication is active and `auth.test` returns `ok: true`.

## 4. Send messages

Send with `POST /chat.postMessage` and a JSON body containing `channel` and `text`:

```js
await api.request({
  slug: "slack",
  method: "POST",
  path: "/chat.postMessage",
  headers: { Accept: "application/json", "Content-Type": "application/json" },
  json: { channel, text },
  timeoutMs: 30000,
});
```

Use the channel identifier exactly as the user supplied it. Make discovery calls such as
`conversations.list` only when the user asks to resolve or browse channels. Require
`body.ok === true` and report Slack's `error` otherwise.

**Complete when** Slack confirms the message with `ok: true`.

## 5. Configure inbound Slack events

Inspect before writing:

```js
const existing = await api.getWebhookEndpoint({ endpointId: "slack" });
```

Use this Slack challenge configuration:

```js
const verification = {
  type: "challenge",
  method: "POST",
  when: {
    type: "equals",
    source: { type: "jsonBodyPath", path: ["type"] },
    value: "url_verification",
  },
  response: {
    type: "echoText",
    source: { type: "jsonBodyPath", path: ["challenge"] },
  },
};
const deliveryIdentity = { type: "jsonBodyPath", path: ["event_id"] };
```

When the endpoint is absent, create it as a draft. `createWebhookEndpoint` replaces the complete
resource, so use it only in this branch:

```js
await api.createWebhookEndpoint({
  endpointId: "slack",
  name: "Slack",
  status: "draft",
  verification,
  deliveryIdentity,
  auth: { type: "none" },
});
```

When the endpoint exists, preserve its stored secrets and unrelated configuration. Use
`updateWebhookEndpoint` and include only fields that must change. In particular, omit `auth` when
the existing `authConfig` is already Slack-compatible HMAC; omission preserves the stored signing
secret:

```js
await api.updateWebhookEndpoint({
  endpointId: "slack",
  verification,
  deliveryIdentity,
});
```

A Slack-compatible existing HMAC configuration has all of these values:

- `type: "hmac"` and `algorithm: "sha256"`
- signature header `x-slack-signature`, hex encoding, and prefix `v0=`
- timestamped body prefix `v0:`, header `x-slack-request-timestamp`, delimiter `:`, and a 300-second
  tolerance
- at least one stored `secretRef`

Collect a Signing Secret only when creating the endpoint or replacing absent/incompatible HMAC.
Activate or repair it with one patch containing the necessary changed fields and this `auth` value:

```js
await api.updateWebhookEndpoint({
  endpointId: "slack",
  status: "active",
  verification,
  deliveryIdentity,
  auth: {
    type: "hmac",
    secret: signingSecret,
    algorithm: "sha256",
    signature: {
      location: "header",
      name: "x-slack-signature",
      encoding: "hex",
      prefix: "v0=",
    },
    signedPayload: {
      type: "timestampedBody",
      prefix: "v0:",
      timestampHeader: "x-slack-request-timestamp",
      delimiter: ":",
      toleranceSeconds: 300,
    },
  },
});
```

Re-read the endpoint after every write. Give its `publicUrl` to the user for **Slack App → Event
Subscriptions → Request URL**. Tell the user to subscribe to the `app_mention` bot event, grant
`app_mentions:read` and `chat:write`, reinstall the Slack app when scopes change, and retry Request
URL verification.

**Complete when** the re-read endpoint is active with Slack challenge handling, `event_id` delivery
identity, and timestamped HMAC verification. Never report an existing setup as verified from status
alone.

## 6. Prove event delivery

When the user asks whether a Slack message arrived, call:

```js
await hooks.list({ fragment: "api", pageSize: 10 });
```

Find the newest completed `onWebhookReceived` entry whose payload has `endpointId: "slack"`. Confirm
receipt from its parsed `body.event`, including event type, channel, and message text when present.
Keep authorization tokens, signatures, raw headers, and unrelated payload fields out of the
response.

A received event proves ingestion only. State clearly when no automation exists yet to reply.
Sending a reply requires `chat.postMessage`, normally using `body.event.channel`; use
`body.event.ts` as `thread_ts` only when the requested reply should be threaded.

**Complete when** the newest matching delivery is identified, or the absence of one is reported.
