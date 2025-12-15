---
"@fragno-dev/db": patch
---

fix: use RETURNING clause for version conflict detection when affected rows unavailable

Enable version conflict detection for drivers that support RETURNING but don't report affected rows
(e.g., SQLocal). When version checking is enabled, UPDATE/DELETE queries now use RETURNING 1 to
detect if a row was modified, falling back to affected rows when available.
