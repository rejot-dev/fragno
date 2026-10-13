---
"@fragno-dev/backoffice-api": patch
---

feat: remove the `api.webhooks.*` operations; inbound webhooks are set up as `webhook#<endpointId>`
integrations. `secretFields` names nested secrets as dot-separated paths.
