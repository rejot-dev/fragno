---
"@fragno-dev/db": patch
"@fragno-dev/tanstack-db-adapter": patch
---

feat: export SQL naming from `@fragno-dev/db/naming` without `node:crypto`, and the `/_internal`
description call from `@fragno-dev/db/outbox`. fix: derive `/_internal` URLs correctly from a base
URL without a path.
