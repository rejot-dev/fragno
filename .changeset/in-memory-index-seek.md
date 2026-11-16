---
"@fragno-dev/db": patch
---

perf: seek to the rows an index's leading equalities select in the in-memory adapter, instead of
scanning the whole index
