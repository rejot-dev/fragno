---
name: slack-setup
description:
  Set up or verify Slack in Backoffice for bot-token API calls, sending messages, Events API
  webhooks, app mentions, URL verification, signing-secret validation, or checking whether a Slack
  event arrived.
---

# Slack setup

Set Slack up as one handshake: **connect → verify → receive → prove**.

## 1. Inspect the Slack connections

Slack uses two connections: its Web API at `api#slack` for sending, and its Events API webhook at
`webhook#slack` for receiving. Inspect both before setting either up:

```js
const [outbound, inbound] = await Promise.all([
  integrations.setup({ kind: "check", connectionId: "api#slack" }),
  integrations.setup({ kind: "check", connectionId: "webhook#slack" }),
]);
```

A `ready` outbound result means the bot token is stored; continue at step 3 to prove it. A `ready`
inbound result means the endpoint is active with its signing secret; step 5 checks its contract.

**Complete when** both connections' setup status is known.

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

Request the Bot User OAuth Token only when `api#slack` is not ready, and the Signing Secret only
when `webhook#slack` is not ready or its stored auth is not Slack's (step 5). Use
`credentials.payload.botUserOAuthToken` and `credentials.payload.signingSecret` only inside later
`step.do` calls. Keep them out of workflow output, tool summaries, and prose.

**Complete when** the workflow has received every missing secret through
`slack.credentials-submitted`.

## 3. Connect the Slack bot

When `api#slack` is not ready, set it up with the submitted **Bot User OAuth Token**:

```js
await integrations.setup({
  kind: "input",
  connectionId: "api#slack",
  input: {
    type: "bearer",
    name: "Slack",
    baseUrl: "https://slack.com/api",
    token: botUserOAuthToken,
  },
});
```

Treat tokens as secrets: use the exact user-supplied value only in the tool call and omit it from
results and prose. Then prove the token with Slack's `POST /auth.test`:

```js
const result = await integrations.execute({
  connectionId: "api#slack",
  actionId: "request",
  input: {
    method: "POST",
    path: "/auth.test",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: { type: "json", value: {} },
  },
});
```

Slack API calls can return HTTP 200 for failures, so require both `result.ok` and
`result.response.body.value.ok === true`.

If verification fails, report Slack's `error` value and stop. Never replace a missing token with a
placeholder or test credential.

**Complete when** authentication is active and `auth.test` returns `ok: true`.

## 4. Send messages

Send with `POST /chat.postMessage` and a JSON body containing `channel` and `text`:

```js
await integrations.execute({
  connectionId: "api#slack",
  actionId: "request",
  input: {
    method: "POST",
    path: "/chat.postMessage",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: { type: "json", value: { channel, text } },
    timeoutMs: 30000,
  },
});
```

Use the channel identifier exactly as the user supplied it. Make discovery calls such as
`conversations.list` only when the user asks to resolve or browse channels. Require
`result.response.body.value.ok === true` and report Slack's `error` otherwise.

**Complete when** Slack confirms the message with `ok: true`.

## 5. Configure inbound Slack events

Slack's Events API contract, with the signing secret:

```js
const contract = {
  name: "Slack",
  verification: {
    type: "challenge",
    method: "POST",
    when: {
      type: "equals",
      source: { type: "jsonBodyPath", path: ["type"] },
      value: "url_verification",
    },
    response: { type: "echoText", source: { type: "jsonBodyPath", path: ["challenge"] } },
  },
  deliveryIdentity: { type: "jsonBodyPath", path: ["event_id"] },
  auth: {
    type: "hmac",
    secret: signingSecret,
    algorithm: "sha256",
    signature: { location: "header", name: "x-slack-signature", encoding: "hex", prefix: "v0=" },
    signedPayload: {
      type: "timestampedBody",
      prefix: "v0:",
      timestampHeader: "x-slack-request-timestamp",
      delimiter: ":",
      toleranceSeconds: 300,
    },
  },
};
```

When `webhook#slack` is not ready, submit it to setup:

```js
await integrations.setup({ kind: "input", connectionId: "webhook#slack", input: contract });
```

When it is ready, read the stored contract with
`integrations.execute({ connectionId: "webhook#slack", actionId: "endpoint.describe", input: {} })`.
Its `authConfig` is Slack-compatible when it is `hmac` with `sha256`, header `x-slack-signature`,
hex encoding, prefix `v0=`, and a timestamped body with prefix `v0:`, header
`x-slack-request-timestamp`, delimiter `:`, and a 300-second tolerance. If the verification or
delivery identity differ, reconfigure with the contract and `auth: { type: "keep" }`, which keeps
the stored signing secret. Collect a new Signing Secret only when the stored auth is not
Slack-compatible, and reconfigure with the full contract.

Give the user the webhook URL from `endpoint.describe` for **Slack App → Event Subscriptions →
Request URL**. Tell the user to subscribe to the `app_mention` bot event, grant `app_mentions:read`
and `chat:write`, reinstall the Slack app when scopes change, and retry Request URL verification.

**Complete when** `endpoint.describe` reports the endpoint active with Slack's challenge, `event_id`
delivery identity, and Slack-compatible HMAC. Never report an existing setup as verified from status
alone.

## 6. Prove event delivery

Slack verifies the Request URL by sending a signed challenge, so a successful verification already
proves the URL and signing secret. Check it, and any later delivery, with:

```js
await integrations.verify({ connectionId: "webhook#slack" });
```

Its `delivery.received` check is `passed` when Slack's latest request was accepted, `failed` with
the reason when it was rejected, and `not-checked` before any arrived. A signature failure usually
means the stored signing secret is not this Slack app's.

When the user asks whether a Slack message arrived, list the newest `api` `webhook.received` events
with `events.list` and find the one whose payload has `endpointId: "slack"`. Stored events omit the
delivery body, so read it with
`integrations.execute({ connectionId: "webhook#slack", actionId: "delivery.get", input: { deliveryId } })`,
passing the event's `deliveryId`. Deliveries are kept for a week after they are processed. Confirm
receipt from its `body.event`, including event type, channel, and message text when present. Keep
authorization tokens, signatures, raw headers, and unrelated payload fields out of the response.

A received event proves ingestion only. State clearly when no automation exists yet to reply.
Sending a reply requires `chat.postMessage`, normally using `body.event.channel`; use
`body.event.ts` as `thread_ts` only when the requested reply should be threaded.

**Complete when** the newest matching delivery is identified, or the absence of one is reported.
