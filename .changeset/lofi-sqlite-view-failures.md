---
"@fragno-dev/lofi": patch
---

fix: report a SQL or read view that fails to refresh to its page instead of keeping its old data as
ready, and report it again once it recovers. An engine that fails to refresh no longer stops the
others, and gets its changed tables again with the next batch. A view engine's `materialize` now
takes `fail`, which reports a failed refresh.
