---
"@fragno-dev/backoffice-api": patch
---

feat: add `existingRun` to `start_workflow` route actions. Omitted, or `"keep"`, a run with the
rendered instance ID stays as it is and the route skips; `"restart_finished"` starts a finished run
again.
