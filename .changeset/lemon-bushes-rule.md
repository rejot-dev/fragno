---
"@fragno-dev/db": patch
---

Properly construct return type for `find` and `findFirst` with `select()`. The return type now
correctly infers only the selected columns from the builder function, providing better type safety
when using `.select()` to specify a subset of columns.
