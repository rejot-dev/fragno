---
"@fragno-dev/unplugin-fragno": patch
---

Client builds now replace `defineFragmentWithDatabase` with `defineFragment` and remove
`.withDatabase()` calls, reducing bundle size by eliminating server-only database code.
