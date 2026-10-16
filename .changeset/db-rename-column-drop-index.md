---
"@fragno-dev/db": patch
"@fragno-dev/lofi": patch
---

feat: `alterTable()` can rename columns (`renameColumn`) and drop indexes (`dropIndex`), keeping the
table's rows. Lofi keys its IndexedDB indexes by the schema's current indexes.
