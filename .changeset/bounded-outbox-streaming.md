---
"@fragno-dev/db": patch
---

perf: stream bounded outbox pages item by item with database backpressure, isolate bounded catch-up
work, share one live polling loop across active stream observers, reuse one UTF-8 frame encoding
across observers receiving the same entry, and keep normalized SQL mutation payloads as opaque JSON
through entry assembly and framing.
