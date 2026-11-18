---
"@fragno-dev/workflows": patch
---

fix: an interrupted tick schedules the tick of every step it left waiting, such as a sleep or a
retry, as a suspended tick does. Its rerun finds those steps already waiting, so before this a sleep
first reached in an interrupted tick never woke.
