---
"@fragno-dev/api-fragment": patch
---

feat: store accepted webhook deliveries, readable through
`GET /webhooks/endpoints/:endpointId/deliveries/:deliveryId`, and delete them
`webhookDeliveryRetentionMs` after their `onWebhookReceived` hook succeeds. Breaking: set the new
required `webhookDeliveryRetentionMs` option, and type `onWebhookReceived` payloads as
`WebhookDelivery` from `@fragno-dev/api-fragment/types`, which replaces `WebhookReceivedPayload`.
`onWebhookReceived` hooks queued before upgrading complete without running.
