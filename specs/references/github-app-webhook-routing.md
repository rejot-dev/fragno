# GitHub App Webhook Routing References

External references used for this spec:

1. GitHub Apps webhook configuration (single webhook URL in app settings):
   https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
2. Webhook delivery handling patterns:
   https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries
3. Webhook signature validation (`x-hub-signature-256`):
   https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
4. GitHub App installation event payloads (contains `installation.id`):
   https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation
5. Installation repositories event payloads:
   https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation_repositories

Cloudflare references:

1. Durable Objects storage and alarms: https://developers.cloudflare.com/durable-objects/
2. Workers secrets management: https://developers.cloudflare.com/workers/configuration/secrets/
