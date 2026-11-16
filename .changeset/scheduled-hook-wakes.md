---
"@fragno-dev/db": patch
---

perf: schedule Cloudflare durable hook alarms without reading the hooks on every request

`HookNotifyContext` gains `dueAt`: when the earliest hook a notification announces is due, or `null`
when it only asks the dispatcher to check its alarm. The Durable Object dispatcher remembers the
next wake time it read, moves it earlier for each announced hook, and reads the hooks again only
after processing them.
