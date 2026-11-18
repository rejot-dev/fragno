---
"@fragno-dev/workflows": patch
---

fix: a wake or retry tick that arrives before every waiting step is due now runs instead of
rescheduling itself to the earliest deadline. Each step resumes only when its own time has come, so
a checkpointed branch no longer waits for a sleep or event timeout beside it.
