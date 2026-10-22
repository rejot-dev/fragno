---
"@fragno-dev/db": patch
---

feat!: each durable hook owns its retry policy, passed as `defineHook(fn, { retryPolicy })`, with
`isRetryable(error)` to fail at once and jittered backoff; the default now retries for about half an
hour instead of about 3 seconds. Migrate by moving `TriggerHookOptions.retryPolicy` onto the hook
definition and declaring hook map types as `HookFn<Payload>` instead of plain functions.
