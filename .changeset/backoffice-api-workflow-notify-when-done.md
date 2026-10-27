---
"@fragno-dev/backoffice-api": patch
---

feat: `workflow.instances.create` accepts `notifyWhenDone`, which notifies the calling agent, also
in another scope, with a `workflows` `instance.completed` event naming the run's scope, status,
output, and error.
