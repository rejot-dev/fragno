---
"@fragno-dev/project-connector-fragment": patch
---

feat: add the `onConnectionReadinessChanged` durable hook, which receives
`{ externalUserId, service, connection, ready }` when a named connection gains its first request
(`ready: false`) or its first confirmed account (`ready: true`).
