---
"@fragno-dev/backoffice-api": patch
---

feat!: events forwarded into another scope carry a `forward` causation naming the scope and route
they came from, and start their own causal tree there, so `automationEventRootId` returns their own
ID. Read `causation.from` where you read a forwarded event's `route` causation.
