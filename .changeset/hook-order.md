---
"@fragno-dev/db": patch
---

feat: add `order` to the durable hook context, so hooks can be ordered by creation

Hooks created in the same millisecond share a `createdAt`, so handlers could not tell which came
first. `HookContext.order` is an opaque string: a hook created by a later transaction, or later in
the same transaction, has a greater `order`. On databases that commit transactions concurrently,
such as Postgres and MySQL, it follows creation rather than commit order.
