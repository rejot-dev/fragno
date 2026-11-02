---
"@fragno-dev/github-app-fragment": patch
---

feat: add `POST /installations/:installationId/release`, which forgets an installation that now
serves another store, given its `accountId`, `accountLogin`, and `accountType`: it counts as
deleted, and its repositories and their links are removed, without calling GitHub. The new
`installation.releasedAt` column records the release, also for an installation the store never
synced, and `GET /installations` returns it. Syncs leave a released installation released, answering
`INSTALLATION_RELEASED` (409), so a delivery queued before the release cannot restore it;
`POST /installations/:installationId/sync` with `{ "claim": { "version": … } }` mirrors it again
once it serves the store again.

A claim and a release name the installation row's `version` the caller read, or `null` while the
store has none, and answer `INSTALLATION_SYNC_CONFLICT` once the row changed, so one the caller
confirmed before a later move cannot undo it. `GET /installations/:installationId` and
`GET /installations` return the version.

A sync that another sync of the installation wrote ahead of, such as a webhook's while this one read
GitHub, now returns `INSTALLATION_SYNC_CONFLICT` (409) instead of failing on a duplicate row; sync
again to read what the other one wrote. Webhook processing retries the delivery on it.
