---
"@fragno-dev/db": patch
---

feat: delete completed durable hooks once their last attempt is older than
`completedHookRetentionMinutes` (default 7 days; `false` keeps them). A hook `id` now rejects
duplicate triggers only while its hook is kept.
