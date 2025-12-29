---
"@fragno-dev/db": patch
---

refactor: Rename `nonce` to `idempotencyKey` in public APIs

Rename the `nonce` property to `idempotencyKey` in `HookContext` and `UnitOfWork` interfaces for
better clarity and consistency. The database column name remains `nonce` for backward compatibility.

**Breaking change**: Users accessing `this.nonce` in hook functions or `uow.nonce` in unit of work
operations must update to `this.idempotencyKey` and `uow.idempotencyKey` respectively.
