---
"@fragno-dev/workflows": patch
---

fix: a tick that suspends now waits for the steps started beside the suspending branch, so a
`Promise.all` sibling keeps its result. Each waiting step schedules its own tick, and a wake or
retry tick resumes only the steps due by its time.
