---
"@fragno-dev/db": patch
---

feat: Add unified transaction API with createServiceTx and executeTx

Introduce a new unified transaction API that consolidates multiple transaction execution patterns
into a single `executeTx` function with `TxResult` pattern. This provides better type safety,
clearer composition patterns, and support for nested dependencies.

New APIs:

- `createServiceTx`: Create service-level transactions with dependency support
- `executeTx`: Handler-level transaction execution with unified callback pattern
- `TxResult` type: Branded type for transaction results with dependency tracking
- `handlerTx` method: Added to fragment definitions for convenient access

The old APIs (`executeTxCallbacks`, `executeTxWithDeps`, `executeTxArray`) are deprecated but remain
available for backward compatibility.
