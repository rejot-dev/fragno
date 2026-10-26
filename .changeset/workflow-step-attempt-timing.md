---
"@fragno-dev/workflows": patch
---

fix: Report workflow callback and pump-finalization durations and outcomes separately, including
finalization failures. Migrate log consumers from `fragno.workflow_step_emissions.completed` to
`fragno.workflow_step_attempt.finished`; use `callbackOutcome` and `finalizationOutcome` rather than
interpreting completion as a committed step.
