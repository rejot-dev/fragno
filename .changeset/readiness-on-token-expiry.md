---
"@fragno-dev/api-fragment": patch
"@fragno-dev/mcp-fragment": patch
---

Report `ready: false` through `onConnectionReadinessChanged` and `onServerReadinessChanged` when an
OAuth access token without a refresh token expires. A durable hook is scheduled at expiry and fires
only if that token is still stored; a newer token reports its own readiness.
