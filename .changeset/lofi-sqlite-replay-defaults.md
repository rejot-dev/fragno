---
"@fragno-dev/lofi": patch
---

fix: give a SQLite replica's rows written before a column was added the column's fixed default, as
the backend's migration gave them, instead of NULL. Replica tables now declare regular columns'
fixed defaults, and `LOFI_SQLITE_LAYOUT_VERSION` is 3, so existing replicas download again.
