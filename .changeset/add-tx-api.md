---
"@fragno-dev/db": patch
---

feat(db): add tx() API for simplified transaction handling

Add new tx() method to both service and handler contexts that provides a simpler API for transaction
handling with automatic retry support. Supports two syntaxes: array syntax for multiple service
calls and callback syntax for direct UOW access. Also enhances restrict() to accept options for
controlling readiness signaling.
