---
"@fragno-dev/lofi": patch
---

feat: report catch-up progress from `LofiClient` streams with `onCatchUp`, and expose a SQLite
replica's download progress and `caught-up` state, shared across tabs, with `getStatus` and
`subscribeStatus`.
