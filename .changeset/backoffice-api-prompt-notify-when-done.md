---
"@fragno-dev/backoffice-api": patch
---

feat: `pi.prompt.submit` accepts `notifyWhenDone`, which notifies the calling agent, also in another
scope, with the `turn.*` or `queue.dropped` event recording how the prompt ended.
