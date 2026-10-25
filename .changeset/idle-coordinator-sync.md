---
"@fragno-dev/tanstack-db-adapter": patch
---

fix: keep synchronizing after five idle minutes; the coordinator's internal collection was garbage
collected while unsubscribed, which stopped every collection from receiving changes.
