---
"@fragno-dev/tanstack-db-adapter": patch
---

fix: give each outbox coordinator its own table and internal collection IDs, so React live queries
can switch between coordinators for different sources. Existing local databases catch up again from
the beginning.
