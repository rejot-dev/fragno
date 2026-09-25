---
"@fragno-dev/db": patch
---

perf: stream bounded outbox pages item by item with database backpressure, isolate bounded catch-up
work, and share one live polling loop across active stream observers.
