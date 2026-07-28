---
"@fragno-dev/db": patch
---

fix: snapshot mutable column values at the in-memory database boundary so writes and reads match
persisted database value semantics.
