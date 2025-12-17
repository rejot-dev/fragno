---
"@fragno-dev/db": minor
---

Add durable hooks system for database fragments. Hooks are automatically persisted and retried on
failure, allowing fragment authors to define side effects that execute after successful transaction
commits.
