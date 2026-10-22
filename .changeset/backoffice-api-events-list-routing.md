---
"@fragno-dev/backoffice-api": patch
---

feat: `events.list` returns each event's `routing`, as `events.get` does. `events.routes.list` lists
the routes in one state, such as `failed` or `retrying`, each with the event it matched, newest
match first.
