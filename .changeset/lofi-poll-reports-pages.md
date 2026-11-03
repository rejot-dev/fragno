---
"@fragno-dev/lofi": patch
---

fix: report each page a poll commits through `onSyncApplied` and `onSyncComplete`, as a stream
reports each batch, so a later page that fails no longer hides the changes earlier pages committed
