---
"@fragno-dev/backoffice-api": patch
---

feat: event definitions take a `keyPath`, such as `$.entityId`, naming where their events hold the
key of what they are about. Each key's latest event is kept as its state, which outlives the events.
`events.state.list` and `events.state.delete` read and delete a type's state, and
`events.catalog.update` changes a definition.
