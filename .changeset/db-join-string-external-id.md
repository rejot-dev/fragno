---
"@fragno-dev/db": patch
---

fix: A query-tree join that compares a row's `id` with a plain string column of its parent now
matches on the external id the column holds. It compared the internal id instead, so such joins,
such as `onIndex("primary", (eb) => eb("id", "=", eb.parent("eventId")))`, never matched.
