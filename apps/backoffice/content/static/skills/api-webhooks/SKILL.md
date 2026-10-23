---
name: api-webhooks
description:
  Configure inbound webhooks end to end. Use when the user needs a webhook/callback URL, provides
  webhook auth or sample payloads, defines provider events, or routes webhook.received deliveries
  into cataloged automation events.
---

# Inbound Webhooks

An inbound webhook is the integration `webhook#<endpointId>`: a public URL that accepts one
provider's deliveries and records each as an `api.webhook.received` event. The user needs the URL
before anything else: most providers show the signing secret only once a webhook with a URL exists.
Take the steps in order.

## 1. Get the URL

Make this your first action, before reading the provider's documentation. Derive a lowercase
`endpointId` from the provider name and run the setup check, which stores nothing:

```js
await integrations.setup({ connectionId: "webhook#acme", kind: "check" });
```

Setup refuses IDs that Backoffice already uses as an event source, such as `github`; take its
suggested ID. The endpoint ID also names the source of the provider's reclassified events.

**Complete when** you hold the webhook URL from the check's instructions.

## 2. Read the provider's contract

Read the provider's webhook documentation and fill in each part of the setup input from it:

- `deliveryIdentity`: where each delivery carries a unique ID, such as a `webhookId` field or a
  delivery-ID header;
- `auth`: how deliveries are authenticated, with every signature detail;
- `verification`: a challenge the provider sends when the URL is entered, or `{ type: "none" }`;
- the event types and their discriminator field, such as `type`, with example payloads.

For signatures or challenges, read `/static/skills/api-webhooks/references/contract.md`.

**Complete when** every part is filled from the documentation or written down as a question for the
user.

## 3. Hand over the URL

Send one reply that opens with the webhook URL. Ask the user to create the webhook in the provider
with it and paste back the signing secret the provider then shows. After the URL, state the contract
you found and ask only the questions from step 2.

A provider whose `verification` is a challenge checks the URL as it is entered, so it needs step 4
done first. Such providers, like Slack, show their secret up front: ask for the secret now, and say
the URL works once setup completes.

**Complete when** your reply opens with the webhook URL.

## 4. Activate the endpoint

Submit the complete contract to `integrations.setup` with `kind: "input"`; setup returns `ready`.
Until then the URL answers 404 and deliveries are lost, so the user sends test deliveries after this
step.

To change an existing endpoint, submit the complete contract to `integrations.reconfigure`; pass
`auth: { type: "keep" }` to keep the stored secret. The `endpoint.describe` action returns the URL,
status, stored contract, and latest delivery outcomes, naming secrets only by reference.

**Complete when** setup returns `ready`.

## 5. Register provider events

For each event type, call `events.catalogCreate` with `source` set to the endpoint ID, a stable
`eventType` from the provider's discriminator, a label and description, a payload schema for the
projected payload, a representative example, and `enabled: true`. Every route projection must
produce all of the schema's required fields.

**Complete when** every event type the user wants has a catalog entry.

## 6. Route deliveries

Read `/static/skills/building-automations/references/event-routing.md`, then create one
`reclassify_event` route per catalog entry, triggered by `api` `webhook.received`. Each route
matches `$.payload.endpointId`, so it consumes only this endpoint's deliveries, plus the
discriminator when the provider sends several event types. Webhook fields are under `$.payload` and
provider body fields under `$.payload.body`.

```js
await router.create({
  id: "acme-record-created",
  name: "Classify Acme record-created webhooks",
  enabled: true,
  trigger: {
    kind: "event",
    source: "api",
    eventType: "webhook.received",
    matcher: {
      all: [
        { path: "$.payload.endpointId", op: "eq", value: "acme" },
        { path: "$.payload.body.type", op: "eq", value: "record.created" },
      ],
    },
  },
  action: {
    kind: "reclassify_event",
    source: "acme",
    eventType: "record.created",
    payload: { kind: "projection", fields: { recordId: "$.payload.body.recordId" } },
  },
});
```

**Complete when** every catalog entry has a route whose projection covers its required fields.

## 7. Verify end to end

Ask the user for a test delivery, then run `integrations.verify`. Its `delivery.received` check is
`passed` when the latest request was accepted, `failed` with the reason when it was rejected, and
`not-checked` before any arrived. Anyone with the URL can cause a rejection, so confirm a failure
with the user before changing the contract.

Then find the matching `api.webhook.received` event and each expected `<endpointId>.<eventType>`
event with `events.list`, and check each payload against its catalog schema. When a reclassified
event is missing, the automations hook queue holds its projection or schema error.

**Complete when** the check passed and every expected event is stored, or the user has the failure
and its cause.

## Completion response

End with one inventory: connection ID, endpoint name, and webhook URL; authentication and
verification mode, without secret values; every `source.eventType`; every route as
`trigger → destination` with its matchers; and the verification result with the matching event IDs.
When setup is still waiting, list the missing inputs.

## Event envelope

`api.webhook.received` carries `endpointId`, `deliveryId`, `hookId`, `receivedAt`, redacted
`headers` and `query`, the parsed JSON `body`, and `contentType`. Repeated deliveries with the same
endpoint and delivery ID share one `hookId`; use it, or the event ID, for idempotency.

Routes match and project from the whole envelope, but the stored event omits `headers`, `query`, and
`body`, so `events.list` and `events.get` do not show them. Read them with the connection's
`delivery.get` action and the event's `deliveryId`; deliveries are kept for a week after they are
processed.
