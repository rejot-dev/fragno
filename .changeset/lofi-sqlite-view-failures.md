---
"@fragno-dev/lofi": patch
---

fix: report a SQL or read view that fails to refresh to its page instead of keeping its old data as
ready, and report it again once it recovers. An engine that fails to refresh no longer stops the
others, and gets its changed tables again with the next batch. A view engine's `materialize` now
takes `fail`, which reports a failed run. A SQL or read view whose first run fails is kept, runs
again after later batches, and reports its data once it succeeds, instead of failing until the page
asks for it again.

fix: a replica worker that fails to open the replica, for example on a failed `GET /_internal`,
tries again after `retryDelayMs` instead of giving up, so a brief outage while the leading tab
closes no longer leaves every tab without a leader. Pages connect meanwhile, with the error in their
status. Only a backend replaced since the page loaded still rejects `connectLofiSqlite`.

feat: a replica's new `adapterIdentity` option names the backend the page expects. Tabs share a
leader only with tabs that expect the same backend, and the replica refuses to open on a backend
that reports another identity.
