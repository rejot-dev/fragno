---
"@fragno-dev/github-app-fragment": patch
---

feat: store verified webhook deliveries, readable through `GET /webhooks/deliveries/:deliveryId`,
and delete them `webhookDeliveryRetentionMs` after their hook succeeds; the CLI sets it with
`--webhook-delivery-retention-hours` (default 168). Breaking: set the new required
`webhookDeliveryRetentionMs` option. `GitHubAppWebhookMeta.receivedAt` is now always set, and
`processWebhook` hooks queued before upgrading complete without running.
