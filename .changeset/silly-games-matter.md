---
"@fragno-dev/db": patch
---

Add `hasNextPage` field to cursor pagination results. The `CursorResult` interface now includes an
explicit `hasNextPage: boolean` field that accurately indicates whether more results are available.
