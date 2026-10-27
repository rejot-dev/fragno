---
"@fragno-dev/backoffice-api": patch
---

feat: `pi.prompt.get` tells where a prompt submitted with a request ID stands: queued, running,
completed, or failed with the reason it will not be answered, or null when the agent never received
it.
