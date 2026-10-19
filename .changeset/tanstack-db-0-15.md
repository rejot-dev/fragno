---
"@fragno-dev/tanstack-db-adapter": patch
---

feat: Require TanStack DB 0.15 and SQLite persistence 0.2.36, and wait for each table commit to
become visible during outbox delivery so failed commits fail the coordinator.
