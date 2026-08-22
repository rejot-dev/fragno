---
name: api-webhooks
description:
  Configure inbound API webhooks end to end. Use when the user needs a webhook/callback URL,
  provides webhook auth or sample payloads, defines provider events, or routes webhook.received
  deliveries into cataloged automation events.
---

# API Webhooks

Configure one coherent webhook contract: endpoint, event source, cataloged provider events, routes,
and verification. Use codemode and return a final inventory so the user can see exactly what was
registered.

## Setup sequence

### 1. Reserve the endpoint URL

Immediately create a draft endpoint with a stable lowercase `endpointId` derived from the provider
name, then give the user the exact `publicUrl` returned by the tool.

```js
const draft = await api.createWebhookEndpoint({
  endpointId: "example-provider",
  name: "Example Provider",
  status: "draft",
  verification: { type: "none" },
  deliveryIdentity: { type: "jsonBodyPath", path: ["webhookId"] },
  auth: { type: "none" },
});

return { webhookUrl: draft.publicUrl };
```

Creating the endpoint also provisions an event source named after its `endpointId`. For example,
endpoint `example-provider` owns source `example-provider`. Source provisioning is asynchronous. If
an immediate `events.catalogCreate` reports that this source does not exist, retry that operation a
bounded number of times for this specific error. Keep the endpoint and source identifiers unchanged.

Draft endpoints reserve a stable URL and reject deliveries with `WEBHOOK_ENDPOINT_DRAFT` and
"Webhook endpoint is not configured yet" until activated.

### 2. Establish the webhook contract

Collect the information required to make deliveries deterministic:

- example JSON payloads for every event type the user wants to receive;
- relevant delivery, signature, and discriminator headers;
- a provider delivery ID from a header or payload path;
- authentication details;
- endpoint verification challenge details, when applicable;
- the payload field that discriminates event types, such as `type`.

Keep the endpoint in `draft` while required details are missing. The `endpointId` is the only value
to deduce without evidence.

Choose `deliveryIdentity` from a stable provider identifier such as `webhookId`, `event.id`, `id`,
or a provider delivery-ID header.

Authentication choices are `none`, `bearer`, `apiKey`, `basic`, and `hmac`. Treat “webhook secret,”
“signing secret,” “key,” or a secret-shaped webhook value as an HMAC clue and collect the algorithm,
signature location and name, encoding, optional prefix, and signed-payload format. Use bearer
authentication only when the provider explicitly sends `Authorization: Bearer ...`.

### Setup guardrails

- The API capability is available automatically for the current scope. Webhook endpoints share its
  storage and public URL configuration.
- Use the shared `api` capability directly; `connections.setup` is for outbound API connections.
- Give the user the complete, fully qualified receiving URL returned as `webhook.publicUrl`. Refer
  to it as the webhook URL, not the public base URL.
- Assemble the final URL only from the tool result. The documented URL shape is explanatory, not a
  substitute for `webhook.publicUrl`.
- Ask for example payloads and relevant headers before choosing delivery identities, schemas, or
  routes.
- Derive only the `endpointId` without evidence. Keep the endpoint in draft while authentication,
  signature, verification, payload, header, discriminator, or delivery-identity details are unknown.
- Store authentication secrets through endpoint tools and omit secret values from summaries,
  schemas, event examples, and completion responses.

### 3. Register provider events

For each distinct provider event, call `events.catalogCreate` with:

- `source`: the webhook `endpointId`;
- a stable `eventType` derived from the provider event discriminator;
- a useful label and description;
- a payload schema based on the projected event payload;
- a representative example;
- `enabled: true`.

```js
const registered = await events.catalogCreate({
  source: "example-provider",
  eventType: "record.created",
  label: "Example Provider record created",
  description: "A record was created in Example Provider.",
  payloadSchema: {
    type: "object",
    properties: {
      recordId: { type: "string" },
      data: { type: "object" },
    },
    required: ["recordId"],
    additionalProperties: true,
  },
  example: { recordId: "rec_123", data: { status: "new" } },
  enabled: true,
});
```

The registered schema is the destination contract. Every route projection must produce all its
required fields.

### 4. Route accepted deliveries

Accepted deliveries first produce `api.webhook.received`. Create one reclassification route for each
cataloged provider event.

Every route must be endpoint-scoped. When the provider carries multiple event types, also match its
event discriminator. Without the endpoint matcher, a route consumes deliveries from every API
webhook endpoint.

The route matcher and projection inspect the complete automation event envelope. Webhook fields are
under `$.payload`; provider body fields are under `$.payload.body`.

```js
const route = await router.create({
  id: "example-provider-record-created",
  name: "Classify Example Provider record-created webhooks",
  enabled: true,
  trigger: {
    kind: "event",
    source: "api",
    eventType: "webhook.received",
    matcher: {
      all: [
        { path: "$.payload.endpointId", op: "eq", value: "example-provider" },
        { path: "$.payload.body.type", op: "eq", value: "record.created" },
      ],
    },
  },
  action: {
    kind: "reclassify_event",
    source: "example-provider",
    eventType: "record.created",
    payload: {
      kind: "projection",
      fields: {
        recordId: "$.payload.body.recordId",
        data: "$.payload.body.data",
      },
    },
  },
  description:
    "Reclassifies Example Provider record.created deliveries as example-provider record.created events.",
});
```

Projection paths always start with `$.`. Compare the projection against the destination event schema
before creating the route; every required destination field must resolve for a matching delivery.

### 5. Activate the endpoint

Update the draft only after the webhook contract is known. When the user supplies the complete
contract before setup begins, creating the endpoint directly as `active` is also valid.

```js
const webhook = await api.updateWebhookEndpoint({
  endpointId: "example-provider",
  status: "active",
  verification: { type: "none" },
  deliveryIdentity: { type: "jsonBodyPath", path: ["webhookId"] },
  auth: { type: "none" },
});
```

For HMAC, configure the exact provider contract:

```js
const webhook = await api.updateWebhookEndpoint({
  endpointId: "example-provider",
  status: "active",
  verification: { type: "none" },
  deliveryIdentity: { type: "jsonBodyPath", path: ["webhookId"] },
  auth: {
    type: "hmac",
    secret: "whs_secret_123",
    algorithm: "sha256",
    signature: {
      location: "header",
      name: "x-provider-signature",
      encoding: "hex",
      prefix: "sha256=",
    },
    signedPayload: { type: "rawBody" },
  },
});
```

### HMAC decision guide

- `algorithm`: use the provider's documented `sha1`, `sha256`, or `sha512` algorithm.
- `signature.location`: use `header` or `query` according to where the provider sends the signature.
- `signature.name`: preserve the exact header or query-parameter name.
- `signature.encoding`: use the documented `hex`, `base64`, or `base64url` encoding.
- `signature.prefix`: include it only when the provider prefixes the encoded signature, such as
  `sha256=` or `v1=`.
- `signedPayload`: use `rawBody` when the provider signs the unmodified request body. Use
  `timestampedBody` when it signs a prefix, timestamp, delimiter, and raw body.
- For `timestampedBody`, preserve the exact `prefix`, `timestampHeader`, and `delimiter`, and use
  the provider's replay-tolerance window. An empty prefix is valid only when the provider signs the
  timestamp first without a prefix.

### Verification challenge guide

Use `{ type: "none" }` for ordinary delivery-only endpoints. Use `challenge` when the provider sends
a synchronous value that must be echoed before deliveries begin.

A challenge configuration specifies:

- the exact HTTP `method`;
- a `present` predicate when the source only needs to exist, or an `equals` predicate when it must
  match a fixed value;
- a match source from a header, query parameter, or JSON body path;
- the header, query parameter, or JSON body path whose value the response echoes.

### Slack-style signed challenge example

```js
const webhook = await api.createWebhookEndpoint({
  endpointId: "slack",
  name: "Slack",
  status: "active",
  verification: {
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
  },
  deliveryIdentity: { type: "jsonBodyPath", path: ["event_id"] },
  auth: {
    type: "hmac",
    secret: "signing-secret",
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

return webhook.publicUrl;
```

### 6. Verify end-to-end

Tell the user when the endpoint is ready for a provider test delivery. Send a representative
delivery when possible, then inspect both queues:

```js
const [apiHooks, automationHooks] = await Promise.all([
  hooks.list({ fragment: "api", pageSize: 20 }),
  hooks.list({ fragment: "automations", pageSize: 50 }),
]);
```

Verification is complete only when:

1. the endpoint returns an accepted response;
2. the matching `onWebhookReceived` API hook completes;
3. the original `api.webhook.received` automation event completes;
4. each expected reclassified `<endpointId>.<eventType>` event completes without projection or
   schema errors.

A `202 Accepted` response or a pending automation hook is intermediate evidence, not completion.
When a hook fails, inspect its exact projection or schema error, repair the route, send a new unique
delivery, and verify again.

## Completion response

Finish every webhook setup with one inventory containing:

- endpoint name, status, and exact fully qualified `publicUrl`;
- event source (`endpointId`);
- every registered `source.eventType`;
- every route as `trigger → destination`, including endpoint and discriminator matchers;
- authentication and verification mode, without secret values;
- end-to-end verification status.

If the endpoint remains a draft, list the missing inputs required for activation. If no provider
events were registered, state that explicitly.

## Event envelope reference

`api.webhook.received` fires after an active endpoint accepts and authenticates a delivery. Its
payload contains:

- `endpointId`
- `deliveryId`
- `hookId`
- `receivedAt`
- redacted `headers`
- redacted `query`
- parsed JSON `body`
- `contentType`

Use `hookId` or the automation event ID for idempotency. Duplicate provider deliveries with the same
endpoint and delivery ID produce the same hook ID.

## Tool reference

Use codemode first.

Webhook endpoint methods:

- `api.listWebhookEndpoints` lists configured endpoints.
- `api.getWebhookEndpoint` inspects one endpoint.
- `api.createWebhookEndpoint` creates or replaces an endpoint.
- `api.updateWebhookEndpoint` updates an endpoint.
- `api.deleteWebhookEndpoint` deletes an endpoint.

A direct active endpoint is appropriate when the complete contract is already known:

```js
const webhook = await api.createWebhookEndpoint({
  endpointId: "example-provider",
  name: "Example Provider",
  status: "active",
  verification: { type: "none" },
  deliveryIdentity: { type: "jsonBodyPath", path: ["webhookId"] },
  auth: { type: "none" },
});

return webhook.publicUrl;
```

Inspect existing configuration before replacing it:

```js
const endpoints = await api.listWebhookEndpoints();
const endpoint = await api.getWebhookEndpoint({ endpointId: "example-provider" });
```

Event and routing methods:

- `events.catalogList`
- `events.catalogGet`
- `events.catalogCreate`
- `router.list`
- `router.get`
- `router.create`
- `router.update`
- `router.delete`

Webhook endpoints use the shared `api` capability automatically. Return the exact tool-provided
`publicUrl`; the receive URL shape is `/api/http/:scope/webhooks/endpoints/:endpointId/events`.
