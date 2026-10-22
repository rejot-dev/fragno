---
"@fragno-dev/db": patch
---

feat: Retry a durable hook that failed for good with
`hookService.retryFailedHook(namespace, hookId)`, which queues it again with a fresh set of attempts
and wakes its dispatcher. Fragment routes and services reach their own hook service through
`getFragmentDurableHooks(deps)` from `@fragno-dev/db/durable-hooks`.
