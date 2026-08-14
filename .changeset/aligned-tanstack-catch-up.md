---
"@fragno-dev/db": patch
"@fragno-dev/tanstack-db-adapter": patch
---

perf: use fixed 500-entry, versionstamp-aligned outbox catch-up pages, persist each page in one
collection transaction, and let initialized collections resume directly from a durable checkpoint.
