---
"@fragno-dev/backoffice-api": patch
---

feat: replace `js.logs` with `js.runs.list` and `js.runs.get`. `js.runs.get` returns one run with
its outcome, console logs, and tool calls; use it where you called `js.logs`.
