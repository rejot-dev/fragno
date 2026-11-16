---
"@fragno-dev/backoffice-api": patch
---

feat: add `sequence` to automation events and event states

Events whose source records several in the same millisecond carry a `sequence` that orders them,
compared as text, such as the order of the durable hook that recorded the event. Events without one
have `null`; stored events read without one have `null` too. Event states copy it.
