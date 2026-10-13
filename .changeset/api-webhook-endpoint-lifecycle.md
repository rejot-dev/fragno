---
"@fragno-dev/api-fragment": minor
---

`onWebhookEndpointChanged` now also fires with `{ change: "deleted", endpointId }` when an endpoint
is deleted, and updates carry `previousStatus` so consumers can tell when an endpoint starts or
stops accepting deliveries. The payload is a discriminated union on `change`; handlers that read
`endpoint` must narrow it first. This is a pre-1.0 breaking change.

Webhook endpoints now report `deliveries`: the last accepted request and the last rejected one with
its error code. Configuration writes clear both. The schema adds three nullable columns to
`webhookEndpoint`, so run the Fragment's migrations.
